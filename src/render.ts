import type { Outcome, SummaryDoc } from './types';
import { pct } from './util';

const MAX_FAILURES = 20;
const MSG_LINES = 6;

export function plainOutcome(o: Outcome): string {
  switch (o.class) {
    case 'passed':
      return o.jobFailedAfterTests ? 'Tests passed, but a later step in the job failed' : 'All tests passed';
    case 'tests_failed':
      return 'Some tests failed';
    case 'errored':
      return o.subReason === 'gate'
        ? 'The test run failed a gate (for example a coverage threshold)'
        : o.subReason === 'setup'
          ? 'The test step did not run (an earlier step failed)'
          : 'The test run crashed before it finished';
    case 'cancelled':
      return 'The run was cancelled';
    case 'timed_out':
      return 'The run timed out';
    case 'no_report':
      return 'No test or coverage report was found';
    case 'inactive':
      return 'Tests are inactive for this job';
  }
}

const icon = (o: Outcome): string => (o.class === 'passed' ? '✅' : o.class === 'inactive' ? '⏸️' : '❌');

const firstLines = (s: string, n: number): string => s.split('\n').slice(0, n).join('\n').replace(/`{3,}/g, "'''");

export interface RenderInput {
  summary: SummaryDoc;
  url: string | null;
  uploaded: 'yes' | 'no' | 'artifact';
  artifactName: string | null;
  problems: string[];
}

export function renderSummary(i: RenderInput): string {
  const s = i.summary;
  const o = s.outcome;
  const out: string[] = [];
  out.push(`## ${icon(o)} ${s.context.flag}: ${plainOutcome(o)}`);
  out.push('');
  if (s.tests) {
    const t = s.tests.totals;
    out.push(`**Tests:** ${t.total} total · ${t.passed} passed · ${t.failed} failed · ${t.errored} errored · ${t.skipped} skipped`);
  } else {
    out.push('**Tests:** no test report was found');
  }
  if (s.coverage) {
    const c = s.coverage.totals;
    const br = c.branches !== null && c.branchesHit !== null ? ` · branches ${pct(c.branchesHit, c.branches)}` : '';
    out.push(`**Coverage:** lines ${pct(c.linesHit, c.lines)} (${c.linesHit}/${c.lines})${br}${s.coverage.partial ? ' · partial (a test binary crashed)' : ''}`);
  } else {
    out.push('**Coverage:** no coverage report was found');
  }
  if (s.patch) out.push(`**Patch coverage:** ${pct(s.patch.hit, s.patch.lines)} (${s.patch.hit}/${s.patch.lines} changed lines)`);
  out.push('');
  if (i.url) out.push(`[Open the full report](${i.url})`);
  else if (i.uploaded === 'artifact') out.push(`The report was not uploaded; it is attached to this run as the artifact \`${i.artifactName}\`.`);
  else out.push('The report was not uploaded.');
  if (s.overCap) out.push('The report is over the size cap, so only the summary was uploaded.');
  out.push('');

  const failures = s.tests?.failures ?? [];
  if (failures.length) {
    out.push(`### Failed tests (${Math.min(failures.length, MAX_FAILURES)}${s.tests!.totals.failed + s.tests!.totals.errored > MAX_FAILURES ? ` of ${s.tests!.totals.failed + s.tests!.totals.errored}` : ''})`);
    out.push('');
    for (const f of failures.slice(0, MAX_FAILURES)) {
      const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      const title = f.suite ? `${f.suite} › ${f.name}` : f.name;
      out.push(`<details><summary><b>${f.status === 'errored' ? 'error' : 'failed'}</b> ${escapeHtml(title)}${where}</summary>`);
      out.push('');
      out.push('```');
      out.push(firstLines(f.message || '(no message)', MSG_LINES));
      out.push('```');
      out.push('</details>');
      out.push('');
    }
  }
  const notes = [...o.notes, ...i.problems].slice(0, 10);
  if (notes.length) {
    out.push('<details><summary>Notes</summary>');
    out.push('');
    for (const n of notes) out.push(`- ${n.replace(/\n/g, ' ')}`);
    out.push('</details>');
    out.push('');
  }
  return out.join('\n');
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
