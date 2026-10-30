import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactName, uploadArtifactFallback } from '../src/artifact';
import { build } from '../src/build';
import { collect, makeId } from '../src/collect';
import { HttpError } from '../src/http';
import { runStart } from '../src/start';
import type { Outcome } from '../src/types';
import { uploadAll } from '../src/upload';
import { fixture, ghEnv, inputs, tmpRepo, write } from './helpers';
import { mock } from './mockhttp';

const outcome: Outcome = {
  testStep: 'failure', jobStatus: 'failure', class: 'tests_failed', subReason: null, jobFailedAfterTests: false,
  startedAt: null, finishedAt: '2026-10-30T10:00:00.000Z', notes: [],
};

function scenario() {
  const r = tmpRepo({ 'src/m.ts': 'export const a = 1;\n', 'tests/m.test.ts': 'x\n' });
  write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
  write(r, 'reports/unit/console.log', fixture('bun/console.log'));
  write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
  const i = inputs({ language: 'bun' });
  const built = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
  return { r, i, built };
}

describe('upload flow (CONTRACT §2)', () => {
  test('known-failing → finish → report → cov → raw → sources/check → sources', async () => {
    const { r, built } = scenario();
    const m = mock();
    const res = await uploadAll(m.client, 'unit', built, r);
    const scope = `?flag=unit&job=${built.summary.context.job}`;
    expect(m.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/runs/known-failing?flag=unit',
      'POST /api/v1/runs/finish',
      'PUT /api/v1/runs/123/report',
      'PUT /api/v1/runs/123/cov/0',
      'PUT /api/v1/runs/123/raw/junit.xml',
      'PUT /api/v1/runs/123/raw/lcov.info',
      'PUT /api/v1/runs/123/raw/console.log',
      `POST /api/v1/sources/check${scope}`,
      `PUT /api/v1/sources/${built.summary.sources[0]!.blob}${scope}`,
    ]);
    expect(res).toMatchObject({ finished: true, runId: 123, url: 'https://reports.atomi.cloud/o/r/commit/abc', problems: [] });
  });

  test('sources/check and the blob PUTs carry ?flag=&job=', async () => {
    const { r, built } = scenario();
    const m = mock();
    await uploadAll(m.client, 'a b', built, r);
    const src = m.calls.filter(c => c.path.startsWith('/api/v1/sources/'));
    expect(src.length).toBe(2);
    for (const c of src) expect(c.path).toContain(`?flag=a%20b&job=${built.summary.context.job}`);
  });

  test('no caps: all raw files and all missing sources are uploaded', async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 30; n++) files[`src/f${n}.ts`] = `export const n = ${n};\n`;
    const r = tmpRepo(files);
    for (let n = 0; n < 9; n++) write(r, `out/${n}/r.xml`, '<testsuite name="s"><testcase classname="a" name="b"/></testsuite>');
    write(r, 'out/lcov.info', Object.keys(files).map(f => `SF:${f}\nDA:1,1\nend_of_record\n`).join(''));
    const i = inputs({ language: 'generic', tests: ['out/*/r.xml'], coverage: ['out/lcov.info'] });
    const built = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
    const m = mock();
    const res = await uploadAll(m.client, 'unit', built, r);
    expect(m.calls.filter(c => c.path.includes('/raw/')).length).toBe(10);
    expect(m.calls.filter(c => c.method === 'PUT' && c.path.startsWith('/api/v1/sources/')).length).toBe(30);
    expect(res.problems).toEqual([]);
  });

  test('a fresh OIDC token is requested for every call', async () => {
    const { r, built } = scenario();
    const m = mock();
    await uploadAll(m.client, 'unit', built, r);
    expect(m.tokens.length).toBe(m.calls.length);
    expect(new Set(m.calls.map(c => c.token)).size).toBe(m.calls.length);
  });

  test('bodies: finish is the summary JSON; PUTs are gzip with application/gzip', async () => {
    const { r, built } = scenario();
    const m = mock();
    await uploadAll(m.client, 'unit', built, r);
    const fin = m.calls.find(c => c.path === '/api/v1/runs/finish')!;
    expect(fin.contentType).toBe('application/json');
    expect(fin.json.schema).toBe('diene-summary/v1');
    const rep = m.calls.find(c => c.path.endsWith('/report'))!;
    expect(rep.contentType).toBe('application/gzip');
    expect(rep.gz![0]).toBe(0x1f);
    expect(rep.json.schema).toBe('diene-report/v1');
    expect(m.calls.find(c => c.path.endsWith('/cov/0'))!.json.schema).toBe('diene-cov/v1');
    expect(m.calls.find(c => c.path.endsWith('/raw/junit.xml'))!.json).toBeInstanceOf(Buffer);
  });

  test('the source blob PUT carries the raw file bytes (the Worker re-hashes them)', async () => {
    const { r, built } = scenario();
    const m = mock();
    await uploadAll(m.client, 'unit', built, r);
    const put = m.calls.find(c => c.path.startsWith('/api/v1/sources/') && c.method === 'PUT')!;
    expect(put.json.toString('utf8')).toBe('export const a = 1;\n');
  });

  test('only the blobs the server says are missing are uploaded', async () => {
    const { r, built } = scenario();
    const m = mock(c => (c.path.startsWith('/api/v1/sources/check') ? { status: 200, body: { missing: [] } } : undefined));
    await uploadAll(m.client, 'unit', built, r);
    expect(m.calls.some(c => c.method === 'PUT' && c.path.startsWith('/api/v1/sources/'))).toBe(false);
  });

  test('known-failing ids that pass now are sent as tests.recovered', async () => {
    const { r, built } = scenario();
    const adds = built.report!.tests!.cases.find(c => c.name === 'adds')!.id;
    const fails = built.report!.tests!.cases.find(c => c.name === 'fails')!.id;
    const m = mock(c => (c.path.startsWith('/api/v1/runs/known-failing') ? { status: 200, body: { ids: [adds, fails, makeId('unit', 'gone')] } } : undefined));
    await uploadAll(m.client, 'unit', built, r);
    expect(m.calls.find(c => c.path === '/api/v1/runs/finish')!.json.tests.recovered).toEqual([adds]);
  });

  test('a failing known-failing call does not stop the upload', async () => {
    const { r, built } = scenario();
    const m = mock(c => (c.path.startsWith('/api/v1/runs/known-failing') ? { status: 403 } : undefined));
    const res = await uploadAll(m.client, 'unit', built, r);
    expect(res.finished).toBe(true);
    expect(res.problems.join()).toMatch(/known-failing/);
    expect(m.calls.some(c => c.path === '/api/v1/runs/finish')).toBe(true);
  });

  test('overCap: finish only', async () => {
    const { r, built } = scenario();
    built.overCap = true;
    const m = mock();
    await uploadAll(m.client, 'unit', built, r);
    expect(m.calls.map(c => c.method + ' ' + c.path).filter(x => !x.startsWith('GET'))).toEqual(['POST /api/v1/runs/finish']);
  });

  test('finish failing → finished:false so the caller can fall back to the artifact', async () => {
    const { r, built } = scenario();
    const m = mock(c => (c.path === '/api/v1/runs/finish' ? { status: 401, body: { error: 'bad token' } } : undefined));
    const res = await uploadAll(m.client, 'unit', built, r);
    expect(res.finished).toBe(false);
    expect(res.problems.join()).toMatch(/finish: POST .* 401/);
    expect(m.calls.some(c => c.path.endsWith('/report'))).toBe(false);
  });

  test('a failing report PUT is reported but the rest still goes up', async () => {
    const { r, built } = scenario();
    const m = mock(c => (c.path.endsWith('/report') ? { status: 413 } : undefined));
    const res = await uploadAll(m.client, 'unit', built, r);
    expect(res.finished).toBe(true);
    expect(res.problems.join()).toMatch(/report: PUT .* 413/);
    expect(m.calls.some(c => c.path.endsWith('/cov/0'))).toBe(true);
  });

  test('a rate limit (429 after retries) stops raw and sources but not report/cov', async () => {
    const { r, built } = scenario();
    const m = mock(c => (c.path.includes('/raw/') ? { status: 429 } : undefined));
    const res = await uploadAll(m.client, 'unit', built, r);
    expect(res.problems.length).toBe(1);
    expect(m.calls.filter(c => c.path.includes('/raw/')).length).toBe(4);
    expect(m.calls.some(c => c.path.startsWith('/api/v1/sources/check'))).toBe(false);
  });
});

describe('retries (CONTRACT §2.8)', () => {
  test('429 / 5xx are retried 3 times with 1 s, 3 s, 9 s backoff, then succeed', async () => {
    const m = mock((c, n) => (c.path === '/api/v1/runs/start' && n < 4 ? { status: n === 1 ? 429 : 502 } : undefined));
    await m.client.request('POST', '/api/v1/runs/start', { json: {} });
    expect(m.calls.length).toBe(4);
    expect(m.sleeps).toEqual([1000, 3000, 9000]);
    expect(m.tokens.length).toBe(4);
  });
  test('gives up after 3 retries with the last error', async () => {
    const m = mock(() => ({ status: 503, body: { error: 'down' } }));
    const err = await m.client.request('GET', '/x').catch(e => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
    expect(m.calls.length).toBe(4);
  });
  test.each([400, 401, 403, 404, 413])('%i is never retried', async status => {
    const m = mock(() => ({ status }));
    const err = await m.client.request('GET', '/x').catch(e => e);
    expect(err.status).toBe(status);
    expect(m.calls.length).toBe(1);
    expect(m.sleeps).toEqual([]);
  });
  test('network errors are retried; a token failure is retried too', async () => {
    const m = mock();
    let boom = 0;
    const real = m.deps.fetch;
    m.deps.fetch = async (u, i) => {
      if (boom++ < 2) throw new Error('ECONNRESET');
      return real(u, i);
    };
    await m.client.request('GET', '/api/v1/runs/known-failing?flag=a');
    expect(m.sleeps).toEqual([1000, 3000]);
  });
});

describe('mode: start', () => {
  test('writes the state file and posts diene-start/v1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const m = mock();
    const env = ghEnv({ runnerTemp: dir, pr: 12, baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) });
    const now = new Date('2026-10-30T10:00:00Z');
    const r = await runStart(inputs({ language: 'go', timeoutMinutes: 20 }), env, m.client, now);
    expect(r.posted).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'diene-report-unit.json'), 'utf8'))).toEqual({ startedAt: now.toISOString(), timeoutMinutes: 20 });
    expect(m.calls.length).toBe(1);
    expect(m.calls[0]!.json).toEqual({
      schema: 'diene-start/v1', flag: 'unit', job: 'unit', language: 'go', workflow: 'CI', timeoutMinutes: 20,
      headSha: 'c'.repeat(40), pr: 12, baseRef: 'main', baseSha: 'b'.repeat(40),
    });
  });
  test('without OIDC it still writes the state file and does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const r = await runStart(inputs(), ghEnv({ runnerTemp: dir }), null);
    expect(r.posted).toBe(false);
    expect(existsSync(join(dir, 'diene-report-unit.json'))).toBe(true);
    expect(r.problems.join()).toMatch(/no OIDC/);
  });
  test('a server failure is a problem, not an exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const m = mock(() => ({ status: 400 }));
    const r = await runStart(inputs(), ghEnv({ runnerTemp: dir }), m.client);
    expect(r.posted).toBe(false);
    expect(r.problems.join()).toMatch(/400/);
  });
});

describe('artifact fallback', () => {
  test('uploads summary.json + report.json as test-report-<flag>', async () => {
    const { built } = scenario();
    const dir = mkdtempSync(join(tmpdir(), 'art-'));
    const seen: { name: string; files: string[] }[] = [];
    const name = await uploadArtifactFallback('unit', built, dir, async (n, files) => {
      seen.push({ name: n, files: files.map(f => readFileSync(f, 'utf8')) });
    });
    expect(name).toBe('test-report-unit');
    expect(seen[0]!.name).toBe('test-report-unit');
    expect(JSON.parse(seen[0]!.files[0]!).schema).toBe('diene-summary/v1');
    expect(JSON.parse(seen[0]!.files[1]!).schema).toBe('diene-report/v1');
  });
  test('overCap: summary only', async () => {
    const { built } = scenario();
    built.report = null;
    const files: string[] = [];
    await uploadArtifactFallback('unit', built, mkdtempSync(join(tmpdir(), 'art-')), async (_n, f) => void files.push(...f));
    expect(files.length).toBe(1);
  });
  test('artifact names are sanitized', () => {
    expect(artifactName('a/b c')).toBe('test-report-a_b_c');
  });
});
