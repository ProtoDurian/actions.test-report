import type { ParsedTests, RawCase } from '../types';

interface TestInfo {
  name: string;
  suiteID: number;
  line: number | null;
  rootLine: number | null;
  url: string | null;
  hiddenLoad: boolean;
  errors: { error: string; stack: string; isFailure: boolean }[];
}

export function parseDartJson(text: string): ParsedTests {
  const suites = new Map<number, string>();
  const tests = new Map<number, TestInfo>();
  const startTimes = new Map<number, number>();
  const cases: RawCase[] = [];
  const warnings: string[] = [];
  const crashReasons: string[] = [];
  let done = false;
  let unreadable = 0;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l.startsWith('{')) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(l);
    } catch {
      unreadable++;
      continue;
    }
    switch (ev.type) {
      case 'suite':
        suites.set(ev.suite.id, ev.suite.path ?? '');
        break;
      case 'testStart': {
        const t = ev.test;
        tests.set(t.id, {
          name: t.name ?? '',
          suiteID: t.suiteID,
          line: typeof t.line === 'number' ? t.line : null,
          rootLine: typeof t.root_line === 'number' ? t.root_line : null,
          url: typeof t.url === 'string' ? t.url : null,
          hiddenLoad: typeof t.name === 'string' && t.name.startsWith('loading ') && t.line === null,
          errors: [],
        });
        startTimes.set(t.id, ev.time ?? 0);
        break;
      }
      case 'error':
        tests.get(ev.testID)?.errors.push({
          error: String(ev.error ?? ''),
          stack: String(ev.stackTrace ?? ''),
          isFailure: !!ev.isFailure,
        });
        break;
      case 'testDone': {
        const t = tests.get(ev.testID);
        if (!t) break;
        const suitePath = suites.get(t.suiteID) ?? '';
        if (t.hiddenLoad) {
          // a file that failed to load or compile has no tests; keep the reason without inventing a test case
          if (ev.result !== 'success' && !ev.skipped) {
            const why = t.errors.map(e => e.error).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
            crashReasons.push(`${suitePath || t.name}: could not load tests${why ? `: ${why}` : ''}`);
          }
          break;
        }
        if (ev.hidden) break;
        let status: RawCase['status'];
        if (ev.skipped) status = 'skipped';
        else if (ev.result === 'success') status = 'passed';
        else if (ev.result === 'failure') status = 'failed';
        else status = 'errored';
        const bad = status === 'failed' || status === 'errored';
        cases.push({
          identity: `${suitePath}::${t.name}`,
          suite: suitePath,
          name: t.name,
          file: suitePath || null,
          line: t.rootLine !== null && t.url && suitePath && !t.url.endsWith(suitePath) ? t.rootLine : t.line,
          status,
          durationMs: Math.max(0, (ev.time ?? 0) - (startTimes.get(ev.testID) ?? 0)),
          message: bad ? t.errors.map(e => e.error).join('\n').trim() || null : null,
          stack: bad ? t.errors.map(e => e.stack).join('\n').trim() || null : null,
        });
        break;
      }
      case 'done':
        done = true;
        break;
    }
  }
  if (!done) warnings.push('dart test JSON has no "done" event: the test process probably crashed or was killed');
  if (unreadable) warnings.push(`dart test JSON: ${unreadable} unreadable line(s) skipped`);
  return { cases, warnings, crashReasons };
}
