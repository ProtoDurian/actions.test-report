import type { ParsedTests, RawCase, TestStatus } from '../types';
import { asArray } from '../util';
import { parseXml, textOf, type XNode } from './xml';

const ASSERTION = /\bAssert\b|Assertion|Xunit\.Sdk|Shouldly|Expected:?[\s\S]*(Actual|But was|Received)/;

function durationMs(d: string | undefined): number {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d ?? '');
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  return Math.round((((days * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000);
}

export function mapTrxOutcome(outcome: string, message: string): TestStatus {
  switch (outcome) {
    case 'Passed':
    case 'PassedButRunAborted':
      return 'passed';
    case 'Failed':
      return ASSERTION.test(message) ? 'failed' : 'errored';
    case 'Error':
    case 'Timeout':
    case 'Aborted':
    case 'Disconnected':
      return 'errored';
    default:
      // NotExecuted, Inconclusive, Pending, NotRunnable, Warning
      return 'skipped';
  }
}

function classFromName(testName: string): string {
  const paren = testName.indexOf('(');
  const head = paren >= 0 ? testName.slice(0, paren) : testName;
  const i = head.lastIndexOf('.');
  return i > 0 ? head.slice(0, i) : '';
}

export function parseTrx(text: string): ParsedTests {
  const doc = parseXml(text);
  const run: XNode = doc.TestRun ?? {};
  const classByTestId = new Map<string, string>();
  for (const ut of asArray(run.TestDefinitions?.UnitTest)) {
    const cn = ut.TestMethod?.['@_className'];
    if (cn) classByTestId.set(ut['@_id'], cn);
  }
  const cases: RawCase[] = [];
  for (const r of asArray(run.Results?.UnitTestResult)) {
    const testName: string = r['@_testName'] ?? '';
    const outcome: string = r['@_outcome'] ?? '';
    const info = r.Output?.ErrorInfo;
    const msg = textOf(info?.Message).trim();
    const stack = textOf(info?.StackTrace).trim();
    const status = mapTrxOutcome(outcome, msg);
    const cls = classByTestId.get(r['@_testId']) ?? classFromName(testName);
    const shortName = cls && testName.startsWith(cls + '.') ? testName.slice(cls.length + 1) : testName;
    let file: string | null = null;
    let line: number | null = null;
    const loc = /\bin (.+?):line (\d+)/.exec(stack);
    if (loc) {
      file = loc[1]!;
      line = Number(loc[2]);
    }
    const failed = status === 'failed' || status === 'errored';
    cases.push({
      identity: testName,
      suite: cls,
      name: shortName,
      file: failed ? file : null,
      line: failed ? line : null,
      status,
      durationMs: durationMs(r['@_duration']),
      message: failed || status === 'skipped' ? msg || null : null,
      stack: failed ? stack || null : null,
    });
  }
  const crashReasons: string[] = [];
  const summary: XNode = run.ResultSummary ?? {};
  const texts = [
    ...asArray(summary.RunInfos?.RunInfo)
      .filter(r => r['@_outcome'] === 'Error')
      .map(r => textOf(r.Text)),
    ...(summary['@_outcome'] === 'Aborted' ? [textOf(summary.Output?.StdErr)] : []),
  ];
  for (const t of texts) {
    const one = t.replace(/\s+/g, ' ').trim();
    // plain test failures are listed as RunInfo errors too ('[FAIL]'); only keep run-level problems
    if (one && !/\[(FAIL|SKIP|PASS)\]/.test(one)) crashReasons.push(one.slice(0, 300));
  }
  return { cases, warnings: [], crashReasons };
}
