import { describe, expect, test } from 'bun:test';
import { classify, hasGateLine, type ClassifyInput } from '../src/classify';

const base: ClassifyInput = {
  testOutcome: 'success',
  jobStatus: 'success',
  hasTestFile: true,
  hasCoverageFile: true,
  failedOrErrored: 0,
  totalTests: 3,
  gateMarker: false,
  inactiveMarker: false,
  consoleGateLine: false,
  startedAt: '2026-10-30T10:00:00Z',
  finishedAt: '2026-10-30T10:10:00Z',
  timeoutMinutes: 30,
};
const c = (o: Partial<ClassifyInput>) => classify({ ...base, ...o });

describe('CONTRACT §5 rule 1: job cancelled', () => {
  test('elapsed < timeout - 3min → cancelled', () => {
    expect(c({ jobStatus: 'cancelled' }).class).toBe('cancelled');
  });
  test('elapsed >= timeout - 3min → timed_out', () => {
    expect(c({ jobStatus: 'cancelled', finishedAt: '2026-10-30T10:27:00Z' }).class).toBe('timed_out');
    expect(c({ jobStatus: 'cancelled', finishedAt: '2026-10-30T10:26:59Z' }).class).toBe('cancelled');
    expect(c({ jobStatus: 'cancelled', finishedAt: '2026-10-30T10:45:00Z' }).class).toBe('timed_out');
  });
  test('no start time → cancelled (cannot prove a timeout)', () => {
    expect(c({ jobStatus: 'cancelled', startedAt: null }).class).toBe('cancelled');
  });
  test('wins over a failing test step and over the report', () => {
    expect(c({ jobStatus: 'cancelled', testOutcome: 'failure', failedOrErrored: 2 }).class).toBe('cancelled');
  });
});

describe('rule 2: INACTIVE marker', () => {
  test('marker and no tests → inactive', () => {
    expect(c({ inactiveMarker: true, hasTestFile: false, hasCoverageFile: false, totalTests: 0, testOutcome: 'skipped' }).class).toBe('inactive');
  });
  test('marker with an empty report → inactive', () => {
    expect(c({ inactiveMarker: true, totalTests: 0 }).class).toBe('inactive');
  });
  test('marker but tests did run → the normal rules apply', () => {
    expect(c({ inactiveMarker: true }).class).toBe('passed');
  });
});

describe('rule 3: test step success', () => {
  test('no test file and no coverage file → no_report', () => {
    expect(c({ hasTestFile: false, hasCoverageFile: false, totalTests: 0 }).class).toBe('no_report');
  });
  test('only a coverage file → passed', () => {
    expect(c({ hasTestFile: false, totalTests: 0 }).class).toBe('passed');
  });
  test('only a test file → passed', () => {
    expect(c({ hasCoverageFile: false }).class).toBe('passed');
  });
  test('jobFailedAfterTests when the job later failed', () => {
    const r = c({ jobStatus: 'failure' });
    expect(r.class).toBe('passed');
    expect(r.jobFailedAfterTests).toBe(true);
  });
  test('jobFailedAfterTests is false on success and when job status is unknown', () => {
    expect(c({}).jobFailedAfterTests).toBe(false);
    expect(c({ jobStatus: null }).jobFailedAfterTests).toBe(false);
  });
  test('a report with failures but a green step is still passed, with a note', () => {
    const r = c({ failedOrErrored: 1 });
    expect(r.class).toBe('passed');
    expect(r.notes.join(' ')).toMatch(/failed/);
  });
});

describe('rule 4: test step failure', () => {
  test('failed or errored tests → tests_failed', () => {
    expect(c({ testOutcome: 'failure', jobStatus: 'failure', failedOrErrored: 1 }).class).toBe('tests_failed');
  });
  test('no failed test + GATE_FAILED marker → errored:gate', () => {
    expect(c({ testOutcome: 'failure', gateMarker: true })).toMatchObject({ class: 'errored', subReason: 'gate' });
  });
  test('no failed test + console ❌ coverage line → errored:gate', () => {
    expect(c({ testOutcome: 'failure', consoleGateLine: true })).toMatchObject({ class: 'errored', subReason: 'gate' });
  });
  test('no failed test, no gate evidence → errored:crash', () => {
    expect(c({ testOutcome: 'failure' })).toMatchObject({ class: 'errored', subReason: 'crash' });
    expect(c({ testOutcome: 'failure', hasTestFile: false, hasCoverageFile: false, totalTests: 0 })).toMatchObject({ class: 'errored', subReason: 'crash' });
  });
  test('tests_failed wins over a gate marker', () => {
    expect(c({ testOutcome: 'failure', gateMarker: true, failedOrErrored: 2 }).class).toBe('tests_failed');
  });
});

describe('rule 5: skipped / cancelled test step', () => {
  test('skipped → errored:setup', () => {
    expect(c({ testOutcome: 'skipped', hasTestFile: false, hasCoverageFile: false, totalTests: 0 })).toMatchObject({ class: 'errored', subReason: 'setup' });
  });
  test('cancelled step → cancelled when early, timed_out when late', () => {
    expect(c({ testOutcome: 'cancelled', jobStatus: 'failure' }).class).toBe('cancelled');
    expect(c({ testOutcome: 'cancelled', jobStatus: 'failure', finishedAt: '2026-10-30T10:40:00Z' }).class).toBe('timed_out');
  });
});

describe('rule 6: unknown / empty test outcome', () => {
  test.each(['', null, 'weird'])('%j with failures → tests_failed + note', v => {
    const r = c({ testOutcome: v, failedOrErrored: 1 });
    expect(r.class).toBe('tests_failed');
    expect(r.notes.length).toBe(1);
  });
  test('any report → passed', () => {
    expect(c({ testOutcome: null }).class).toBe('passed');
    expect(c({ testOutcome: null, hasTestFile: false }).class).toBe('passed');
  });
  test('nothing → no_report', () => {
    expect(c({ testOutcome: '', hasTestFile: false, hasCoverageFile: false, totalTests: 0 }).class).toBe('no_report');
  });
});

test('hasGateLine needs a line starting with ❌ that mentions coverage', () => {
  expect(hasGateLine('ok\n❌ coverage 71% < 80%\n')).toBe(true);
  expect(hasGateLine('  ❌ Coverage gate failed')).toBe(true);
  expect(hasGateLine('❌ lint failed')).toBe(false);
  expect(hasGateLine('coverage is 71% ❌')).toBe(false);
  expect(hasGateLine('')).toBe(false);
});
