import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFinish, readStartedAt } from '../src/finish';
import { readGhEnv } from '../src/env';
import { renderSummary, plainOutcome } from '../src/render';
import { parseToolVersion } from '../src/tool';
import { commitAll, fixture, ghEnv, git, inputs, tmpRepo, write } from './helpers';
import { mock } from './mockhttp';

function repo() {
  const r = tmpRepo({ 'src/m.ts': 'export const a = 1;\n', 'tests/m.test.ts': 'x\n' });
  write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
  write(r, 'reports/unit/console.log', fixture('bun/console.log'));
  write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
  return r;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'fin-'));

describe('runFinish end to end', () => {
  test('failing tests with OIDC: classified tests_failed, uploaded, summary written', async () => {
    const r = repo();
    const m = mock();
    const stepSummary = join(tmp(), 'summary.md');
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'failure', jobStatus: 'failure' }), ghEnv({ stepSummary, runnerTemp: tmp() }), { client: m.client, cwd: r, tool: () => 'bun 1.3.13' });
    expect(res).toMatchObject({ class: 'tests_failed', uploaded: 'yes', url: 'https://reports.atomi.cloud/o/r/commit/abc' });
    const md = readFileSync(stepSummary, 'utf8');
    expect(md).toContain('Some tests failed');
    expect(md).toContain('2 failed');
    expect(md).toContain('lines 100.0%');
    expect(md).toContain('Open the full report');
    expect(md).toContain('Expected: 4');
    expect(md).toContain('tests/m.test.ts:5');
  });

  test('no OIDC (fork PR): still parses, classifies, writes the summary and uploads the artifact', async () => {
    const r = repo();
    const stepSummary = join(tmp(), 'summary.md');
    const arts: string[] = [];
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'failure' }), ghEnv({ stepSummary, runnerTemp: tmp(), oidcAvailable: false }), {
      client: null,
      cwd: r,
      uploader: async n => void arts.push(n),
      tool: () => null,
    });
    expect(res).toMatchObject({ class: 'tests_failed', uploaded: 'artifact', url: null });
    expect(arts).toEqual(['test-report-unit']);
    expect(readFileSync(stepSummary, 'utf8')).toContain('artifact `test-report-unit`');
  });

  test('server down (finish 503 after retries): falls back to the artifact, never throws', async () => {
    const r = repo();
    const m = mock(() => ({ status: 503 }));
    const arts: string[] = [];
    const warns: string[] = [];
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'failure' }), ghEnv({ runnerTemp: tmp() }), {
      client: m.client, cwd: r, uploader: async n => void arts.push(n), tool: () => null, warn: w => warns.push(w),
    });
    expect(res.uploaded).toBe('artifact');
    expect(arts).toEqual(['test-report-unit']);
    expect(warns.join()).toMatch(/finish/);
  });

  test('even the artifact upload failing does not throw', async () => {
    const r = repo();
    const res = await runFinish(inputs({ language: 'bun' }), ghEnv({ runnerTemp: tmp() }), {
      client: null, cwd: r, uploader: async () => { throw new Error('no runtime token'); }, tool: () => null,
    });
    expect(res.uploaded).toBe('no');
    expect(res.markdown).toContain('not uploaded');
  });

  test('timed_out uses the start state file', async () => {
    const r = repo();
    const rt = tmp();
    writeFileSync(join(rt, 'diene-report-unit.json'), JSON.stringify({ startedAt: '2026-10-30T10:00:00Z', timeoutMinutes: 30 }));
    const res = await runFinish(inputs({ language: 'bun', jobStatus: 'cancelled' }), ghEnv({ runnerTemp: rt }), {
      client: mock().client, cwd: r, now: () => new Date('2026-10-30T10:29:00Z'), tool: () => null,
    });
    expect(res.class).toBe('timed_out');
    expect(res.summary.outcome.startedAt).toBe('2026-10-30T10:00:00Z');
  });

  test('errored:gate when the console has a ❌ coverage line and no test failed', async () => {
    const r = tmpRepo();
    write(r, 'reports/unit/console.log', '❌ coverage 71% is below 80%\n');
    write(r, 'reports/unit/junit.xml', '<testsuites><testsuite name="s"><testcase classname="a" name="b"/></testsuite></testsuites>');
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'failure' }), ghEnv({ runnerTemp: tmp() }), { client: null, cwd: r, uploader: async () => {}, tool: () => null });
    expect(res.summary.outcome).toMatchObject({ class: 'errored', subReason: 'gate' });
    expect(res.markdown).toContain('gate');
  });

  test('no_report: the run is still reported', async () => {
    const m = mock();
    const res = await runFinish(inputs({ language: 'go', testOutcome: 'success' }), ghEnv({ runnerTemp: tmp() }), { client: m.client, cwd: tmpRepo(), tool: () => null });
    expect(res.class).toBe('no_report');
    expect(res.summary.tests).toBeNull();
    expect(res.summary.coverage).toBeNull();
    expect(m.calls.some(c => c.path === '/api/v1/runs/finish')).toBe(true);
  });

  test('pull request: patch coverage from `git diff HEAD^1 HEAD` on the merge commit', async () => {
    const r = tmpRepo({ 'src/m.ts': 'a\nb\n' });
    git(r, 'checkout', '-q', '-b', 'feature');
    write(r, 'src/m.ts', 'a\nb\nc\nd\n');
    commitAll(r, 'change');
    git(r, 'checkout', '-q', 'main');
    write(r, 'README.md', 'x\n');
    commitAll(r, 'main moves');
    git(r, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    write(r, 'coverage/unit/lcov.info', 'SF:src/m.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,0\nend_of_record\n');
    write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
    const m = mock();
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'success' }), ghEnv({ runnerTemp: tmp(), pr: 5, baseRef: 'main' }), { client: m.client, cwd: r, tool: () => null });
    expect(res.summary.patch).toEqual({ lines: 2, hit: 1, files: [{ path: 'src/m.ts', lines: 2, hit: 1, uncovered: [4] }] });
    expect(res.markdown).toContain('Patch coverage:** 50.0%');
    const report = m.calls.find(c => c.path.endsWith('/report'))!.json;
    expect(report.diff.files['src/m.ts']).toEqual([3, 4]);
  });

  test('a non-git directory still works (no ls-files, no blobs)', async () => {
    const d = tmp();
    write(d, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
    write(d, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
    const res = await runFinish(inputs({ language: 'bun', testOutcome: 'failure' }), ghEnv({ runnerTemp: tmp() }), { client: mock().client, cwd: d, tool: () => null });
    expect(res.class).toBe('tests_failed');
    expect(res.summary.sources).toEqual([]);
  });

  test('step summary lists at most 20 failures', async () => {
    const r = tmpRepo();
    const cases = Array.from({ length: 30 }, (_, i) => `<testcase classname="a" name="t${i}"><failure message="bad ${i}"/></testcase>`).join('');
    write(r, 'out/j.xml', `<testsuite name="s">${cases}</testsuite>`);
    const res = await runFinish(inputs({ language: 'generic', tests: ['out/j.xml'], testOutcome: 'failure' }), ghEnv({ runnerTemp: tmp() }), { client: null, cwd: r, uploader: async () => {}, tool: () => null });
    expect(res.markdown.match(/<details><summary><b>failed/g)!.length).toBe(20);
    expect(res.markdown).toContain('(20 of 30)');
  });
});

describe('render', () => {
  test.each([
    [{ class: 'passed', jobFailedAfterTests: false }, 'All tests passed'],
    [{ class: 'passed', jobFailedAfterTests: true }, 'later step'],
    [{ class: 'tests_failed' }, 'Some tests failed'],
    [{ class: 'errored', subReason: 'gate' }, 'gate'],
    [{ class: 'errored', subReason: 'setup' }, 'did not run'],
    [{ class: 'errored', subReason: 'crash' }, 'crashed'],
    [{ class: 'cancelled' }, 'cancelled'],
    [{ class: 'timed_out' }, 'timed out'],
    [{ class: 'no_report' }, 'No test or coverage report'],
    [{ class: 'inactive' }, 'inactive'],
  ] as const)('%j', (o, text) => {
    expect(plainOutcome(o as never)).toContain(text);
  });
  test('html in test names is escaped', () => {
    const summary: any = {
      context: { flag: 'u' }, outcome: { class: 'tests_failed', notes: [] }, coverage: null, patch: null, overCap: false,
      tests: { totals: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, failures: [{ suite: '<b>x</b>', name: 'a & b', file: null, line: null, status: 'failed', message: 'm' }] },
    };
    const md = renderSummary({ summary, url: null, uploaded: 'no', artifactName: null, problems: [] });
    expect(md).toContain('&lt;b&gt;x&lt;/b&gt; › a &amp; b');
  });
});

describe('env + misc', () => {
  test('readGhEnv: push', () => {
    const e = readGhEnv({ GITHUB_REPOSITORY: 'o/r', GITHUB_REPOSITORY_ID: '9', GITHUB_SHA: 'abc', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '5', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'unit', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' });
    expect(e).toMatchObject({ repository: 'o/r', repositoryId: 9, sha: 'abc', headSha: 'abc', pr: null, runId: 5, runAttempt: 2, oidcAvailable: true });
  });
  test('readGhEnv: pull_request reads the event payload', () => {
    const d = tmp();
    const p = join(d, 'event.json');
    writeFileSync(p, JSON.stringify({ number: 12, pull_request: { number: 12, head: { sha: 'h'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } }, repository: { id: 9, private: false } }));
    const e = readGhEnv({ GITHUB_EVENT_PATH: p, GITHUB_REF: 'refs/pull/12/merge', GITHUB_SHA: 'm'.repeat(40), GITHUB_EVENT_NAME: 'pull_request', RUNNER_TEMP: d });
    expect(e).toMatchObject({ pr: 12, headSha: 'h'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40), repositoryId: 9, visibility: 'public', oidcAvailable: false, runnerTemp: d });
  });
  test('readStartedAt tolerates a missing or broken state file', () => {
    expect(readStartedAt('/nonexistent/x.json')).toBeNull();
    const d = tmp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'bad.json'), '{nope');
    expect(readStartedAt(join(d, 'bad.json'))).toBeNull();
  });
  test.each([
    ['go', 'go version go1.26.8 linux/amd64', 'go 1.26.8'],
    ['bun', '1.3.13', 'bun 1.3.13'],
    ['dotnet', '8.0.404', 'dotnet 8.0.404'],
    ['dart', 'Dart SDK version: 3.5.0 (stable) on "linux_x64"', 'dart 3.5.0'],
  ] as const)('tool version %s', (l, out, want) => {
    expect(parseToolVersion(l, out)).toBe(want);
  });
});
