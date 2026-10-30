import type { OutcomeClass, SubReason } from './types';
import { stripAnsi } from './util';

export interface ClassifyInput {
  testOutcome: string | null;
  jobStatus: string | null;
  hasTestFile: boolean;
  hasCoverageFile: boolean;
  failedOrErrored: number;
  totalTests: number;
  gateMarker: boolean;
  inactiveMarker: boolean;
  /** console log has a line starting with ❌ that mentions "coverage" */
  consoleGateLine: boolean;
  startedAt: string | null;
  finishedAt: string;
  timeoutMinutes: number;
}

export interface Classified {
  class: OutcomeClass;
  subReason: SubReason | null;
  jobFailedAfterTests: boolean;
  notes: string[];
}

const GRACE_MS = 3 * 60_000;

export const hasGateLine = (consoleText: string): boolean =>
  stripAnsi(consoleText).split('\n').some(l => l.trimStart().startsWith('❌') && /coverage/i.test(l));

/** CONTRACT §5 */
export function classify(i: ClassifyInput): Classified {
  const notes: string[] = [];
  const out = (c: OutcomeClass, sub: SubReason | null = null, jobFailedAfterTests = false): Classified => ({
    class: c,
    subReason: sub,
    jobFailedAfterTests,
    notes,
  });
  const elapsed = i.startedAt ? new Date(i.finishedAt).getTime() - new Date(i.startedAt).getTime() : null;
  const cancelled = (): Classified =>
    out(elapsed !== null && elapsed >= i.timeoutMinutes * 60_000 - GRACE_MS ? 'timed_out' : 'cancelled');

  // 1
  if (i.jobStatus === 'cancelled') return cancelled();
  // 2
  if (i.inactiveMarker && (!i.hasTestFile || i.totalTests === 0)) return out('inactive');

  switch (i.testOutcome) {
    case 'success': {
      // 3
      if (!i.hasTestFile && !i.hasCoverageFile) return out('no_report');
      if (i.failedOrErrored > 0) notes.push(`test step succeeded but the report lists ${i.failedOrErrored} failed/errored test(s)`);
      return out('passed', null, i.jobStatus !== null && i.jobStatus !== 'success');
    }
    case 'failure': {
      // 4
      if (i.failedOrErrored > 0) return out('tests_failed');
      const gate = i.gateMarker || i.consoleGateLine;
      return out('errored', gate ? 'gate' : 'crash');
    }
    case 'skipped':
      // 5
      return out('errored', 'setup');
    case 'cancelled':
      return cancelled();
    default: {
      // 6
      notes.push(`test-outcome input was ${i.testOutcome ? `"${i.testOutcome}"` : 'empty'}; outcome inferred from the report alone`);
      if (i.failedOrErrored > 0) return out('tests_failed');
      if (i.hasTestFile || i.hasCoverageFile) return out('passed');
      return out('no_report');
    }
  }
}
