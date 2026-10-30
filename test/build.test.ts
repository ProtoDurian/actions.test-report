import { describe, expect, test } from 'bun:test';
import { build, failuresOf, fitSummary, LIMITS, rawNames, totalsOf } from '../src/build';
import { collect } from '../src/collect';
import { stateFilePath } from '../src/env';
import type { Outcome, SummaryDoc, TestCase } from '../src/types';
import { fixture, ghEnv, inputs, tmpRepo, write } from './helpers';

const outcome: Outcome = {
  testStep: 'failure',
  jobStatus: 'failure',
  class: 'tests_failed',
  subReason: null,
  jobFailedAfterTests: false,
  startedAt: null,
  finishedAt: '2026-10-30T10:00:00.000Z',
  notes: [],
};
const tc = (i: number, status: TestCase['status'] = 'passed', over: Partial<TestCase> = {}): TestCase => ({
  id: String(i).padStart(20, '0'),
  suite: 's',
  name: `t${i}`,
  file: null,
  line: null,
  status,
  durationMs: 1,
  message: status === 'failed' || status === 'errored' ? `m${i}` : null,
  stack: null,
  ...over,
});

function bunRepo() {
  const r = tmpRepo({ 'src/m.ts': 'export const a = 1;\n', 'tests/m.test.ts': 'x\n' });
  write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
  write(r, 'reports/unit/console.log', fixture('bun/console.log'));
  write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
  return r;
}
const make = (over: Partial<Parameters<typeof build>[0]> = {}, repo = bunRepo()) => {
  const i = inputs({ language: 'bun' });
  return build({ inputs: i, env: ghEnv(), collected: collect(i, repo), outcome, tool: 'bun 1.3.13', diff: null, warnings: [], ...over });
};

describe('totals and failures', () => {
  test('counts per status', () => {
    expect(totalsOf([tc(1), tc(2, 'failed'), tc(3, 'errored'), tc(4, 'skipped'), tc(5)])).toEqual({
      total: 5,
      passed: 2,
      failed: 1,
      errored: 1,
      skipped: 1,
      durationMs: 5,
    });
  });
  test('failures: failed first, then errored; passed and skipped excluded', () => {
    const f = failuresOf([tc(1, 'errored'), tc(2), tc(3, 'failed'), tc(4, 'skipped')]);
    expect(f.failures.map(x => x.status)).toEqual(['failed', 'errored']);
    expect(f.truncated).toBe(false);
  });
  test('max 200 failures, flagged as truncated', () => {
    const f = failuresOf(Array.from({ length: 250 }, (_, i) => tc(i, 'failed')));
    expect(f.failures.length).toBe(200);
    expect(f.truncated).toBe(true);
  });
  test('failure message is never null', () => {
    expect(failuresOf([tc(1, 'failed', { message: null })]).failures[0]!.message).toBe('');
  });
});

describe('summary shape (diene-summary/v1)', () => {
  const { summary } = make();
  test('top-level keys and schema', () => {
    expect(Object.keys(summary).sort()).toEqual(['coverage', 'context', 'outcome', 'overCap', 'patch', 'raw', 'schema', 'sources', 'tests', 'warnings'].sort());
    expect(summary.schema).toBe('diene-summary/v1');
    expect(summary.overCap).toBe(false);
  });
  test('context', () => {
    expect(summary.context).toEqual({
      sha: 'a'.repeat(40),
      runId: 7,
      runAttempt: 1,
      headSha: 'a'.repeat(40),
      pr: null,
      baseRef: null,
      baseSha: null,
      workflow: 'CI',
      job: 'unit',
      flag: 'unit',
      language: 'bun',
      tool: 'bun 1.3.13',
      timeoutMinutes: 30,
    });
  });
  test('tests: totals, failures with ids, recovered empty until known-failing is fetched', () => {
    expect(summary.tests!.totals).toEqual({ total: 4, passed: 1, failed: 2, errored: 0, skipped: 1, durationMs: 0 });
    expect(summary.tests!.failures.map(f => f.name)).toEqual(['fails', 'throws']);
    expect(summary.tests!.failures[0]).toMatchObject({ suite: 'math', file: 'tests/m.test.ts', line: 5, status: 'failed' });
    expect(summary.tests!.failures[0]!.id).toMatch(/^[0-9a-f]{20}$/);
    expect(summary.tests!.recovered).toEqual([]);
  });
  test('coverage: totals and a per-file row with its chunk', () => {
    expect(summary.coverage).toEqual({
      format: 'lcov',
      totals: { lines: 2, linesHit: 2, branches: null, branchesHit: null },
      partial: false,
      files: [{ path: 'src/m.ts', lines: 2, hit: 2, chunk: 0 }],
    });
  });
  test('sources have the git blob sha and size; raw lists every parsed file', () => {
    expect(summary.sources).toEqual([{ path: 'src/m.ts', blob: expect.stringMatching(/^[0-9a-f]{40}$/), bytes: 20 }]);
    expect(summary.raw.map(r => [r.name, r.kind]).sort()).toEqual([['console.log', 'console'], ['junit.xml', 'junit'], ['lcov.info', 'lcov']]);
  });
  test('patch is null outside pull requests', () => {
    expect(summary.patch).toBeNull();
  });
});

describe('report shape (diene-report/v1)', () => {
  const b = make();
  test('has the full case list (passed too), coverage lines and context', () => {
    const r = b.report!;
    expect(r.schema).toBe('diene-report/v1');
    expect(r.tests!.cases.length).toBe(4);
    expect(r.coverage!.files).toEqual([{ path: 'src/m.ts', lines: [[1, 33], [2, 55]], branches: null }]);
    expect(r.context).toMatchObject({ repo: 'ProtoDurian/x', repoId: 42, branch: 'main', event: 'push', flag: 'unit', language: 'bun', tool: 'bun 1.3.13' });
    expect(r.outcome).toMatchObject({ class: 'tests_failed', timeoutMinutes: 30 });
    expect(r.diff).toBeNull();
  });
  test('one cov chunk per ≤200 files', () => {
    expect(b.chunks.length).toBe(1);
    expect(b.chunks[0]!.files['src/m.ts']).toBeDefined();
  });
  test('pull request: diff and patch coverage', () => {
    const diff = new Map([['src/m.ts', [1, 2, 3]]]);
    const p = make({ diff, env: ghEnv({ pr: 12, baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) }) });
    expect(p.summary.patch).toEqual({ lines: 2, hit: 2, files: [{ path: 'src/m.ts', lines: 2, hit: 2, uncovered: [] }] });
    expect(p.report!.diff).toEqual({ files: { 'src/m.ts': [1, 2, 3] } });
    expect(p.summary.context).toMatchObject({ pr: 12, baseRef: 'main', headSha: 'c'.repeat(40) });
  });
  test('messages and stacks are capped at 4 KB / 16 KB', () => {
    const r = tmpRepo();
    const cases = '<testsuite name="s"><testcase classname="a" name="b"><failure message="x">' + 'y'.repeat(50_000) + '</failure></testcase></testsuite>';
    write(r, 'out/j.xml', cases);
    const i = inputs({ language: 'generic', tests: ['out/j.xml'] });
    const c = collect(i, r);
    const built = build({ inputs: i, env: ghEnv(), collected: c, outcome, tool: null, diff: null, warnings: [] });
    expect(Buffer.byteLength(built.summary.tests!.failures[0]!.message)).toBeLessThanOrEqual(LIMITS.maxMessage);
    expect(built.summary.tests!.failures[0]!.message).toEndWith('…[truncated]');
  });
});

describe('caps', () => {
  test('more than 50 000 cases → overCap, summary only (no report, chunks, raw or sources)', () => {
    const r = tmpRepo({ 'src/m.ts': 'x\n' });
    write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
    const i = inputs({ language: 'bun' });
    const c = collect(i, r);
    c.cases = Array.from({ length: LIMITS.maxCases + 1 }, (_, n) => tc(n));
    const b = build({ inputs: i, env: ghEnv(), collected: c, outcome, tool: null, diff: null, warnings: [] });
    expect(b.overCap).toBe(true);
    expect(b.summary.overCap).toBe(true);
    expect(b.report).toBeNull();
    expect(b.chunks).toEqual([]);
    expect(b.raw).toEqual([]);
    expect(b.summary.sources).toEqual([]);
    expect(b.summary.warnings.join()).toMatch(/over cap/);
    expect(b.summary.tests!.totals.total).toBe(LIMITS.maxCases + 1);
  });
  test('more than 20 000 coverage files → overCap', () => {
    const i = inputs({ language: 'bun' });
    const c = collect(i, tmpRepo());
    const files = new Map(Array.from({ length: LIMITS.maxCoverageFiles + 1 }, (_, n) => [`f${n}.ts`, { lines: new Map([[1, 1] as [number, number]]), branches: new Map() }]));
    c.coverage = { format: 'lcov', files, partial: false };
    const b = build({ inputs: i, env: ghEnv(), collected: c, outcome, tool: null, diff: null, warnings: [] });
    expect(b.overCap).toBe(true);
    expect(b.report).toBeNull();
    expect(b.summary.coverage!.totals.lines).toBe(LIMITS.maxCoverageFiles + 1);
  });
  test('the summary is trimmed to stay under 2 MB, flagged overCap', () => {
    const failures = Array.from({ length: 200 }, (_, n) => ({
      id: String(n).padStart(20, '0'), suite: 's', name: `n${n}`, file: null, line: null, status: 'failed' as const, durationMs: 0, message: 'm'.repeat(4096), stack: null,
    }));
    const { summary } = make();
    summary.tests!.failures = failures;
    summary.coverage!.files = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/some/long/dir/file' + n + '.ts', lines: 10, hit: 5, chunk: 0 }));
    summary.sources = Array.from({ length: 20_000 }, (_, n) => ({ path: 'src/some/long/dir/file' + n + '.ts', blob: 'a'.repeat(40), bytes: 1 }));
    fitSummary(summary);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(LIMITS.maxSummaryBytes);
    expect(summary.overCap).toBe(true);
  });
  test('a summary that already fits is left alone', () => {
    const { summary } = make();
    const before = JSON.stringify(summary);
    fitSummary(summary);
    expect(JSON.stringify(summary)).toBe(before);
  });
  test('raw: every file is listed (no cap), names match the server pattern and are unique', () => {
    const files = Array.from({ length: 9 }, (_, n) => ({ abs: `/x/${n}/junit.xml`, rel: `d${n}/junit.xml`, kind: 'junit' as const, bytes: 1 }));
    const names = rawNames(files).map(x => x.name);
    expect(new Set(names).size).toBe(9);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
    expect(names.slice(0, 3)).toEqual(['junit.xml', 'junit-2.xml', 'junit-3.xml']);
    const r = tmpRepo();
    for (let n = 0; n < 9; n++) write(r, `out/${n}/r.xml`, '<testsuite name="s"><testcase classname="a" name="b"/></testsuite>');
    const i = inputs({ language: 'generic', tests: ['out/*/r.xml'] });
    const b = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
    expect(b.raw.length).toBe(9);
    expect(b.summary.raw.length).toBe(9);
    expect(b.summary.warnings.join()).not.toMatch(/raw files/);
  });
  test('sources over 1 MB or untracked are not listed', () => {
    const r = tmpRepo({ 'src/big.ts': 'x'.repeat(LIMITS.maxSourceBytes + 1), 'src/m.ts': 'x\n' });
    write(r, 'coverage/unit/lcov.info', 'SF:src/big.ts\nDA:1,1\nend_of_record\nSF:src/m.ts\nDA:1,1\nend_of_record\nSF:/opt/nowhere.ts\nDA:1,1\nend_of_record\n');
    const i = inputs({ language: 'bun' });
    const b = build({ inputs: i, env: ghEnv(), collected: collect(i, r), outcome, tool: null, diff: null, warnings: [] });
    expect(b.summary.sources.map(s => s.path)).toEqual(['src/m.ts']);
  });
});

test('state file path is per flag', () => {
  expect(stateFilePath('/tmp/rt', 'unit')).toBe('/tmp/rt/diene-report-unit.json');
  expect(stateFilePath('/tmp/rt', 'a/b')).toBe('/tmp/rt/diene-report-a_b.json');
});

test('SummaryDoc type is what finish sends', () => {
  const s: SummaryDoc = make().summary;
  expect(s.outcome.class).toBe('tests_failed');
});
