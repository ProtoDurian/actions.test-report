import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uniqueArtifactName, uploadArtifactFallback } from '../src/artifact';
import { build, fitSummary, LIMITS } from '../src/build';
import { hasGateLine } from '../src/classify';
import { collect } from '../src/collect';
import { mergeFile } from '../src/coverage';
import { parseDiff } from '../src/diff';
import { runFinish } from '../src/finish';
import { Client } from '../src/http';
import { assertSecureEndpoint } from '../src/inputs';
import { parseDartJson } from '../src/parsers/dart';
import { parseTrx } from '../src/parsers/trx';
import { renderSummary } from '../src/render';
import type { Outcome } from '../src/types';
import { uploadAll } from '../src/upload';
import { fixture, ghEnv, inputs, tmpRepo, write } from './helpers';
import { mock } from './mockhttp';

const tmp = () => mkdtempSync(join(tmpdir(), 'rv-'));
const outcome: Outcome = {
  testStep: 'failure', jobStatus: 'failure', class: 'tests_failed', subReason: null, jobFailedAfterTests: false,
  startedAt: null, finishedAt: '2026-10-30T10:00:00.000Z', notes: [],
};
function scenario(extra: Record<string, string> = {}) {
  const r = tmpRepo({ 'src/m.ts': 'export const a = 1;\n', 'tests/m.test.ts': 'x\n', ...extra });
  write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
  write(r, 'reports/unit/console.log', fixture('bun/console.log'));
  write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
  const i = inputs({ language: 'bun' });
  const built = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
  return { r, i, built };
}

describe('review #1 timeout-minutes comes from the start state file', () => {
  const repo = () => {
    const r = tmpRepo();
    write(r, 'reports/unit/junit.xml', '<testsuite name="s"><testcase classname="a" name="b"/></testsuite>');
    return r;
  };
  const run = async (timeoutMinutes: number | null, stateMinutes: number, nowIso: string) => {
    const rt = tmp();
    writeFileSync(join(rt, 'diene-report-unit.json'), JSON.stringify({ startedAt: '2026-10-30T10:00:00Z', timeoutMinutes: stateMinutes }));
    return runFinish(inputs({ language: 'bun', jobStatus: 'cancelled', timeoutMinutes }), ghEnv({ runnerTemp: rt }), {
      client: mock().client, cwd: repo(), now: () => new Date(nowIso), tool: () => null,
    });
  };
  test('input unset: a 10-minute job cancelled at minute 10 is timed_out (not judged against 30)', async () => {
    const res = await run(null, 10, '2026-10-30T10:10:00Z');
    expect(res.class).toBe('timed_out');
    expect(res.summary.context.timeoutMinutes).toBe(10);
  });
  test('input unset: a 60-minute job cancelled at minute 28 is cancelled', async () => {
    expect((await run(null, 60, '2026-10-30T10:28:00Z')).class).toBe('cancelled');
  });
  test('an explicit input wins over the state file; no state at all falls back to 30', async () => {
    expect((await run(60, 10, '2026-10-30T10:10:00Z')).class).toBe('cancelled');
    const r = repo();
    const res = await runFinish(inputs({ language: 'bun', jobStatus: 'cancelled', timeoutMinutes: null }), ghEnv({ runnerTemp: tmp() }), {
      client: mock().client, cwd: r, now: () => new Date(), tool: () => null,
    });
    expect(res.summary.context.timeoutMinutes).toBe(30);
  });
});

describe('review #2 upload timeouts, budget and concurrency', () => {
  test('every fetch attempt gets an AbortSignal', async () => {
    const seen: unknown[] = [];
    const m = mock();
    const inner = m.deps.fetch;
    m.deps.fetch = async (u, init) => {
      seen.push(init.signal);
      return inner(u, init);
    };
    await new Client('https://reports.atomi.cloud', m.deps).request('GET', '/api/v1/runs/known-failing?flag=u');
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
  test('a timed-out attempt is retried like a network error', async () => {
    const m = mock();
    const inner = m.deps.fetch;
    let n = 0;
    m.deps.fetch = async (u, init) => {
      if (++n === 1) throw new DOMException('timed out', 'TimeoutError');
      return inner(u, init);
    };
    const res: any = await new Client('https://reports.atomi.cloud', m.deps).request('GET', '/api/v1/runs/known-failing?flag=u');
    expect(res.ids).toEqual([]);
    expect(n).toBe(2);
  });
  test('after the total budget the optional uploads are skipped with one warning; finish still happens', async () => {
    const { r, built } = scenario();
    const m = mock();
    let t = 0;
    m.deps.now = () => t;
    m.deps.fetch = ((inner) => async (u: string, init: any) => {
      if (new URL(u).pathname === '/api/v1/runs/finish') t += 5 * 60_000;
      return inner(u, init);
    })(m.deps.fetch);
    const res = await uploadAll(m.client, 'unit', built, r, 4 * 60_000);
    expect(res.finished).toBe(true);
    expect(m.calls.map(c => c.path)).toEqual(['/api/v1/runs/known-failing?flag=unit', '/api/v1/runs/finish']);
    expect(res.problems.filter(p => /budget/.test(p)).length).toBe(1);
  });
  test('sources are uploaded 6 at a time', async () => {
    const files: Record<string, string> = {};
    const lcov: string[] = [];
    for (let n = 0; n < 20; n++) {
      files[`src/f${n}.ts`] = `export const v${n} = ${n};\n`;
      lcov.push(`SF:src/f${n}.ts\nDA:1,1\nend_of_record`);
    }
    const { r, i } = scenario(files);
    write(r, 'coverage/unit/lcov.info', lcov.join('\n') + '\n');
    const built = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
    expect(built.blobs.size).toBe(20);
    const m = mock();
    let inFlight = 0;
    let peak = 0;
    m.deps.fetch = ((inner) => async (u: string, init: any) => {
      const put = init.method === 'PUT' && new URL(u).pathname.startsWith('/api/v1/sources/');
      if (put) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(res => setTimeout(res, 5));
      }
      try {
        return await inner(u, init);
      } finally {
        if (put) inFlight--;
      }
    })(m.deps.fetch);
    await uploadAll(m.client, 'unit', built, r);
    expect(m.calls.filter(c => c.method === 'PUT' && c.path.startsWith('/api/v1/sources/')).length).toBe(20);
    expect(peak).toBe(6);
  });
});

describe('review #3 branch merge', () => {
  test('1/2 + 1/2 stays 1/2 (max of hits, never the sum)', () => {
    const a = { lines: new Map(), branches: new Map([[10, [1, 2] as [number, number]]]) };
    mergeFile(a, { lines: new Map(), branches: new Map([[10, [1, 2] as [number, number]]]) });
    expect(a.branches.get(10)).toEqual([1, 2]);
    mergeFile(a, { lines: new Map(), branches: new Map([[10, [2, 2] as [number, number]]]) });
    expect(a.branches.get(10)).toEqual([2, 2]);
  });
});

describe('review #4 diff parser', () => {
  test('an added line that starts with "++ " is content, not a file header', () => {
    const d = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,0 +1,2 @@', '+x', '+++ y',
      '@@ -9,0 +12,1 @@', '+z',
    ].join('\n');
    const m = parseDiff(d);
    expect([...m.keys()]).toEqual(['src/a.ts']);
    expect(m.get('src/a.ts')).toEqual([1, 2, 12]);
  });
  test('quoted, octal-escaped paths are decoded', () => {
    const d = ['diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"', '--- "a/\\303\\251.ts"', '+++ "b/\\303\\251.ts"', '@@ -0,0 +1 @@', '+x'].join('\n');
    expect([...parseDiff(d).keys()]).toEqual(['é.ts']);
  });
  test('deleted files and /dev/null are skipped', () => {
    const d = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n');
    expect(parseDiff(d).size).toBe(0);
  });
});

describe('review #5 crash reasons are kept as notes', () => {
  const ev = (o: unknown) => JSON.stringify(o);
  test('dart: a test file that fails to load is reported, without inventing a test case', () => {
    const text = [
      ev({ type: 'start', protocolVersion: '0.1.1', runnerVersion: '1', pid: 1, time: 0 }),
      ev({ type: 'suite', suite: { id: 0, platform: 'vm', path: 'test/a_test.dart' }, time: 1 }),
      ev({ type: 'testStart', test: { id: 1, name: 'loading test/a_test.dart', suiteID: 0, groupIDs: [], metadata: { skip: false, skipReason: null }, line: null, column: null, url: null }, time: 2 }),
      ev({ type: 'error', testID: 1, error: "test/a_test.dart:1:8: Error: Not found: 'package:nope/nope.dart'", stackTrace: '', isFailure: false, time: 3 }),
      ev({ type: 'testDone', testID: 1, result: 'error', skipped: false, hidden: false, time: 4 }),
      ev({ type: 'done', success: false, time: 5 }),
    ].join('\n');
    const p = parseDartJson(text);
    expect(p.cases).toEqual([]);
    expect(p.crashReasons!.join()).toMatch(/a_test\.dart.*could not load tests.*Not found/);
  });
  test('dart: a loading test that succeeds adds nothing', () => {
    const text = [
      ev({ type: 'suite', suite: { id: 0, platform: 'vm', path: 'test/a_test.dart' }, time: 1 }),
      ev({ type: 'testStart', test: { id: 1, name: 'loading test/a_test.dart', suiteID: 0, groupIDs: [], metadata: {}, line: null, column: null, url: null }, time: 2 }),
      ev({ type: 'testDone', testID: 1, result: 'success', skipped: false, hidden: true, time: 4 }),
    ].join('\n');
    expect(parseDartJson(text).crashReasons).toEqual([]);
  });
  test('trx: run-level errors are kept, plain [FAIL]/[SKIP] RunInfo lines are not', () => {
    expect(parseTrx(fixture('dotnet/unit-failing.trx')).crashReasons).toEqual([]);
    const trx = `<TestRun><ResultSummary outcome="Failed"><RunInfos><RunInfo outcome="Error"><Text>The active test run was aborted. Reason: Test host process crashed</Text></RunInfo></RunInfos></ResultSummary></TestRun>`;
    expect(parseTrx(trx).crashReasons).toEqual(['The active test run was aborted. Reason: Test host process crashed']);
  });
  test('they flow into outcome notes and the rendered summary', async () => {
    const r = tmpRepo();
    write(r, 'reports/unit/test.json', [
      JSON.stringify({ type: 'start', protocolVersion: '0.1.1', runnerVersion: '1', pid: 1, time: 0 }),
      JSON.stringify({ type: 'suite', suite: { id: 0, platform: 'vm', path: 'test/a_test.dart' }, time: 1 }),
      JSON.stringify({ type: 'testStart', test: { id: 1, name: 'loading test/a_test.dart', suiteID: 0, groupIDs: [], metadata: {}, line: null, column: null, url: null }, time: 2 }),
      JSON.stringify({ type: 'error', testID: 1, error: 'compile failed', stackTrace: '', isFailure: false, time: 3 }),
      JSON.stringify({ type: 'testDone', testID: 1, result: 'error', skipped: false, hidden: false, time: 4 }),
    ].join('\n'));
    const res = await runFinish(inputs({ language: 'dart', testOutcome: 'failure' }), ghEnv({ runnerTemp: tmp() }), { client: null, cwd: r, uploader: async () => {}, tool: () => null });
    expect(res.summary.outcome.class).toBe('errored');
    expect(res.summary.outcome.subReason).toBe('crash');
    expect(res.summary.outcome.notes.join()).toContain('compile failed');
    expect(res.markdown).toContain('compile failed');
  });
});

describe('review #6/#7/#8 fitSummary and overCap', () => {
  const bigSummary = () => {
    const { built } = scenario();
    const s = built.summary;
    s.coverage!.files = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/some/long/dir/file' + n + '.ts', lines: 10, hit: 5, chunk: 0 }));
    s.sources = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/some/long/dir/file' + n + '.ts', blob: 'a'.repeat(40), bytes: 1 }));
    return built;
  };
  test('#6 dropping only the sources list does not set overCap, and the report is kept', () => {
    const built = bigSummary();
    fitSummary(built.summary);
    expect(Buffer.byteLength(JSON.stringify(built.summary))).toBeLessThanOrEqual(LIMITS.maxSummaryBytes);
    expect(built.summary.sources).toEqual([]);
    expect(built.summary.overCap).toBe(false);
    expect(built.summary.coverage!.files.length).toBe(20_000);
  });
  test('#6 dropping per-file coverage does set overCap', () => {
    const built = bigSummary();
    const s = built.summary;
    s.tests!.failures = Array.from({ length: 4000 }, (_, n) => ({
      id: String(n).padStart(20, '0'), suite: 's', name: `n${n}`, file: null, line: null, status: 'failed' as const, durationMs: 0, message: 'm'.repeat(512), stack: null,
    }));
    s.coverage!.files = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/a/very/long/path/to/some/deeply/nested/dir/with/many/segments/for/length/file' + n + '.ts', lines: 10, hit: 5, chunk: 0 }));
    fitSummary(s);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(LIMITS.maxSummaryBytes);
    expect(s.overCap).toBe(true);
  });
  test('#7 when overCap, no raw files are listed or uploaded', () => {
    const r = tmpRepo();
    write(r, 'reports/unit/junit.xml', '<testsuite name="s"><testcase classname="a" name="b"/></testsuite>');
    const i = inputs({ language: 'bun' });
    const c = collect(i, r);
    c.coverage = { format: 'lcov', files: new Map(Array.from({ length: LIMITS.maxCoverageFiles + 1 }, (_, n) => [`f${n}.ts`, { lines: new Map([[1, 1] as [number, number]]), branches: new Map() }])), partial: false };
    const b = build({ inputs: i, env: ghEnv(), collected: c, outcome, tool: null, diff: null, warnings: [] });
    expect(b.overCap).toBe(true);
    expect(b.summary.raw).toEqual([]);
    expect(b.raw).toEqual([]);
  });
  test('#8 recovered ids are re-fitted so finish stays under 2 MB', async () => {
    const { r, built } = scenario();
    const ids = Array.from({ length: 5000 }, (_, n) => n.toString(16).padStart(20, '0'));
    built.report!.tests!.cases.push(...ids.map(id => ({ id, suite: 's', name: id, file: null, line: null, status: 'passed' as const, durationMs: 0, message: null, stack: null })) as any);
    built.summary.sources = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/some/long/dir/file' + n + '.ts', blob: 'a'.repeat(40), bytes: 1 }));
    // just under the cap before the recovered ids are added
    while (Buffer.byteLength(JSON.stringify(built.summary)) < LIMITS.maxSummaryBytes - 20_000) built.summary.warnings.push('w'.repeat(2000));
    const m = mock(c => (c.path.startsWith('/api/v1/runs/known-failing') ? { status: 200, body: { ids } } : undefined));
    await uploadAll(m.client, 'unit', built, r);
    const body = m.calls.find(c => c.path === '/api/v1/runs/finish')!;
    expect(body.json.tests.recovered.length).toBe(5000);
    expect(Buffer.byteLength(JSON.stringify(body.json))).toBeLessThanOrEqual(LIMITS.maxSummaryBytes);
  });
});

describe('review #9 escaping', () => {
  test('file names and notes in the step summary are HTML-escaped', () => {
    const { built } = scenario();
    built.summary.tests!.failures = [{ id: 'a'.repeat(20), suite: 's', name: 'n', file: '<img src=x onerror=1>.ts', line: 3, status: 'failed', durationMs: 0, message: 'm', stack: null }];
    built.summary.outcome.notes = ['server said <script>alert(1)</script>'];
    const md = renderSummary({ summary: built.summary, url: null, uploaded: 'no', artifactName: null, problems: [] } as any);
    expect(md).not.toContain('<img src=x');
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;img src=x onerror=1&gt;.ts:3');
    expect(md).toContain('&lt;script&gt;');
  });
});

describe('review #10 ANSI gate line', () => {
  test('a colored ❌ coverage line is still a gate', () => {
    expect(hasGateLine('\x1b[31m❌ coverage 71% is below 80%\x1b[0m\n')).toBe(true);
    expect(hasGateLine('ok\n')).toBe(false);
  });
});

describe('review #12 artifact name collisions', () => {
  const built = () => scenario().built;
  test('unique: test-report-<flag>', async () => {
    const names: string[] = [];
    expect(await uploadArtifactFallback('unit', built(), tmp(), async n => void names.push(n))).toBe('test-report-unit');
    expect(names).toEqual(['test-report-unit']);
  });
  test('409: retried once as test-report-<flag>-<job>-<runAttempt>', async () => {
    const b = built();
    const names: string[] = [];
    const up = async (n: string) => {
      names.push(n);
      if (n === 'test-report-unit') throw new Error('Failed to CreateArtifact: (409) Conflict: an artifact with this name already exists on the workflow run');
    };
    const got = await uploadArtifactFallback('unit', b, tmp(), up);
    expect(got).toBe(uniqueArtifactName('unit', b.summary.context.job, b.summary.context.runAttempt));
    expect(got).toBe(`test-report-unit-${b.summary.context.job}-${b.summary.context.runAttempt}`);
    expect(names).toEqual(['test-report-unit', got]);
  });
  test('other errors are not retried', async () => {
    let n = 0;
    await expect(uploadArtifactFallback('unit', built(), tmp(), async () => { n++; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});

describe('review #13 endpoint must be https', () => {
  test('https ok; http only for localhost/127.0.0.1', () => {
    expect(() => assertSecureEndpoint('https://reports.atomi.cloud')).not.toThrow();
    expect(() => assertSecureEndpoint('http://localhost:8787')).not.toThrow();
    expect(() => assertSecureEndpoint('http://127.0.0.1:8787')).not.toThrow();
    expect(() => assertSecureEndpoint('http://reports.atomi.cloud')).toThrow(/https/);
    expect(() => assertSecureEndpoint('ftp://x')).toThrow();
    expect(() => assertSecureEndpoint('nonsense')).toThrow(/valid URL/);
  });
});

describe('review #14 dart root_line', () => {
  test('a test defined by a helper reports the call site (root_line), not the helper line', () => {
    const text = [
      JSON.stringify({ type: 'suite', suite: { id: 0, platform: 'vm', path: 'test/a_test.dart' }, time: 1 }),
      JSON.stringify({ type: 'testStart', test: { id: 1, name: 'works', suiteID: 0, groupIDs: [], metadata: {}, line: 3, column: 5, url: 'file:///x/test/helpers.dart', root_line: 40, root_column: 3, root_url: 'file:///x/test/a_test.dart' }, time: 2 }),
      JSON.stringify({ type: 'testDone', testID: 1, result: 'success', skipped: false, hidden: false, time: 3 }),
      JSON.stringify({ type: 'testStart', test: { id: 2, name: 'plain', suiteID: 0, groupIDs: [], metadata: {}, line: 9, column: 5, url: 'file:///x/test/a_test.dart' }, time: 4 }),
      JSON.stringify({ type: 'testDone', testID: 2, result: 'success', skipped: false, hidden: false, time: 5 }),
    ].join('\n');
    const lines = parseDartJson(text).cases.map(c => c.line);
    expect(lines).toEqual([40, 9]);
  });
});
