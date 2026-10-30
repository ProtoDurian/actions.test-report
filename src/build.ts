import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chunkCoverage, computePatch, coverageTotals, fileLineStats, sortedBranches, sortedLines } from './coverage';
import type { Collected } from './collect';
import { blobSizes } from './git';
import type { GhEnv } from './env';
import type {
  CovChunk,
  CovTotals,
  FailureEntry,
  FoundFile,
  Inputs,
  Outcome,
  ReportDoc,
  SummaryDoc,
  TestCase,
  TestTotals,
} from './types';
import { gzip, jsonBytes, truncBytes } from './util';

export const LIMITS = {
  maxCases: 50_000,
  maxCoverageFiles: 20_000,
  maxUploadBytes: 20 * 1024 * 1024,
  maxSummaryBytes: 2 * 1024 * 1024,
  maxFailures: 200,
  maxMessage: 4 * 1024,
  maxStack: 16 * 1024,
  maxSourceBytes: 1024 * 1024,
  maxSources: 20_000,
};

export function totalsOf(cases: TestCase[]): TestTotals {
  const t: TestTotals = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0, durationMs: 0 };
  for (const c of cases) {
    t[c.status]++;
    t.durationMs += Math.round(c.durationMs);
  }
  return t;
}

export function failuresOf(cases: TestCase[], max = LIMITS.maxFailures): { failures: FailureEntry[]; truncated: boolean } {
  const bad = cases.filter(c => c.status === 'failed' || c.status === 'errored');
  const ordered = [...bad.filter(c => c.status === 'failed'), ...bad.filter(c => c.status === 'errored')];
  const failures = ordered.slice(0, max).map(c => ({
    id: c.id,
    suite: c.suite,
    name: c.name,
    file: c.file,
    line: c.line,
    status: c.status as 'failed' | 'errored',
    durationMs: Math.round(c.durationMs),
    message: c.message ?? '',
    stack: c.stack,
  }));
  return { failures, truncated: ordered.length > max };
}

/** Raw upload names must match ^[A-Za-z0-9._-]{1,100}$ and be unique. */
export function rawNames(files: FoundFile[]): { file: FoundFile; name: string }[] {
  const used = new Set<string>();
  return files.map(file => {
    let base = basename(file.rel).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 90) || 'file';
    let name = base;
    for (let i = 2; used.has(name); i++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
    }
    used.add(name);
    return { file, name };
  });
}

export interface RawUpload {
  name: string;
  kind: FoundFile['kind'];
  bytes: number;
  abs: string;
}

export interface Built {
  summary: SummaryDoc;
  report: ReportDoc | null;
  chunks: CovChunk[];
  raw: RawUpload[];
  /** blob sha -> path, for the sources step */
  blobs: Map<string, string>;
  overCap: boolean;
  diff: Map<string, number[]> | null;
}

export interface BuildCtx {
  inputs: Inputs;
  env: GhEnv;
  collected: Collected;
  outcome: Outcome;
  tool: string | null;
  diff: Map<string, number[]> | null;
  warnings: string[];
}

export function build(ctx: BuildCtx): Built {
  const { inputs, env, collected: c, outcome } = ctx;
  const warnings = [...ctx.warnings];
  let overCap = false;

  let cases = c.cases;
  if (cases) {
    for (const x of cases) {
      if (x.message) x.message = truncBytes(x.message, LIMITS.maxMessage);
      if (x.stack) x.stack = truncBytes(x.stack, LIMITS.maxStack);
    }
  }
  if (cases && cases.length > LIMITS.maxCases) {
    overCap = true;
    warnings.push(`over cap: ${cases.length} test cases (max ${LIMITS.maxCases}); only the summary is uploaded`);
  }

  const testTotals = cases ? totalsOf(cases) : null;
  const fl = cases ? failuresOf(cases) : null;

  const cov = c.coverage;
  const covTotals: CovTotals | null = cov ? coverageTotals(cov) : null;
  let chunks: CovChunk[] = [];
  let chunkOf = new Map<string, number>();
  if (cov) {
    if (cov.files.size > LIMITS.maxCoverageFiles) {
      overCap = true;
      warnings.push(`over cap: ${cov.files.size} coverage files (max ${LIMITS.maxCoverageFiles}); only the summary is uploaded`);
    } else {
      ({ chunks, chunkOf } = chunkCoverage(cov));
    }
  }

  const patch = ctx.diff && cov ? computePatch(cov, ctx.diff) : null;

  // sources: tracked, covered files with a blob <= 1 MB
  const blobs = new Map<string, string>();
  const sources: SummaryDoc['sources'] = [];
  if (cov && !overCap) {
    const wanted = [...cov.files.keys()].filter(p => c.tracked.has(p)).sort();
    const sizes = blobSizes(c.root, [...new Set(wanted.map(p => c.tracked.get(p)!))]);
    for (const p of wanted) {
      const blob = c.tracked.get(p)!;
      const bytes = sizes.get(blob);
      if (bytes === undefined || bytes > LIMITS.maxSourceBytes) continue;
      if (sources.length >= LIMITS.maxSources) break;
      sources.push({ path: p, blob, bytes });
      blobs.set(blob, p);
    }
  }

  // raw files (budgeted)
  const rawAll = rawNames(c.files).filter(r => r.file.bytes <= LIMITS.maxUploadBytes);
  const raw: RawUpload[] = rawAll.map(r => ({ name: r.name, kind: r.file.kind, bytes: r.file.bytes, abs: r.file.abs }));

  const summary: SummaryDoc = {
    schema: 'diene-summary/v1',
    context: {
      sha: env.sha,
      runId: env.runId,
      runAttempt: env.runAttempt,
      headSha: env.headSha,
      pr: env.pr,
      baseRef: env.baseRef,
      baseSha: env.baseSha,
      workflow: env.workflow,
      job: env.job,
      flag: inputs.flag,
      language: inputs.language,
      tool: ctx.tool,
      timeoutMinutes: inputs.timeoutMinutes,
    },
    outcome,
    tests: testTotals && fl ? { totals: testTotals, failures: fl.failures, failuresTruncated: fl.truncated, recovered: [] } : null,
    coverage:
      cov && covTotals
        ? {
            format: cov.format,
            totals: covTotals,
            partial: cov.partial,
            files: [...cov.files.keys()].sort().map(path => {
              const s = fileLineStats(cov.files.get(path)!);
              return { path, lines: s.lines, hit: s.hit, chunk: overCap ? 0 : (chunkOf.get(path) ?? 0) };
            }),
          }
        : null,
    patch,
    sources,
    raw: raw.map(r => ({ name: r.name, kind: r.kind, bytes: r.bytes })),
    warnings,
    overCap,
  };

  let report: ReportDoc | null = null;
  if (!overCap) {
    report = {
      schema: 'diene-report/v1',
      context: {
        repo: env.repository,
        repoId: env.repositoryId,
        visibility: env.visibility,
        sha: env.sha,
        headSha: env.headSha,
        ref: env.ref,
        branch: env.refName,
        event: env.eventName,
        pr: env.pr,
        baseSha: env.baseSha,
        baseRef: env.baseRef,
        runId: env.runId,
        runAttempt: env.runAttempt,
        workflow: env.workflow,
        job: env.job,
        flag: inputs.flag,
        language: inputs.language,
        tool: ctx.tool,
      },
      outcome: { ...outcome, timeoutMinutes: inputs.timeoutMinutes },
      tests: cases && testTotals ? { totals: testTotals, cases } : null,
      coverage:
        cov && covTotals
          ? {
              format: cov.format,
              totals: covTotals,
              partial: cov.partial,
              files: [...cov.files.keys()].sort().map(path => {
                const fc = cov.files.get(path)!;
                return { path, lines: sortedLines(fc), branches: sortedBranches(fc) };
              }),
            }
          : null,
      diff: ctx.diff ? { files: Object.fromEntries([...ctx.diff].sort((a, b) => a[0].localeCompare(b[0]))) } : null,
      sources: sources.map(s => ({ path: s.path, blob: s.blob })),
      raw: summary.raw,
      warnings,
    };
    if (gzip(JSON.stringify(report)).length > LIMITS.maxUploadBytes) {
      overCap = true;
      summary.overCap = true;
      summary.warnings.push('over cap: the full report is larger than 20 MB gzipped; only the summary is uploaded');
      report = null;
      chunks = [];
    }
  }
  if (overCap) {
    summary.sources = [];
    blobs.clear();
    chunks = [];
  }
  fitSummary(summary);
  if (summary.overCap) {
    overCap = true;
    report = null;
    chunks = [];
    blobs.clear();
  }
  return { summary, report, chunks, raw: overCap ? [] : raw, blobs, overCap, diff: ctx.diff };
}

/** Make sure the finish body stays below 2 MB, dropping the least valuable parts first. */
export function fitSummary(s: SummaryDoc, max = LIMITS.maxSummaryBytes): void {
  const fits = (): boolean => jsonBytes(s) <= max;
  if (fits()) return;
  const note = (m: string): void => {
    s.overCap = true;
    s.warnings.push(m);
  };
  if (s.sources.length) {
    s.sources = [];
    note('over cap: source list dropped from the summary');
    if (fits()) return;
  }
  if (s.tests) {
    for (const keep of [50, 10, 0]) {
      s.tests.failures = s.tests.failures.slice(0, keep);
      s.tests.failuresTruncated = true;
      if (fits()) return;
    }
  }
  if (s.patch) {
    for (const f of s.patch.files) f.uncovered = f.uncovered.slice(0, 20);
    if (fits()) return;
    s.patch.files = [];
    if (fits()) return;
  }
  if (s.coverage) {
    s.coverage.files = [];
    note('over cap: per-file coverage dropped from the summary');
  }
  s.warnings = s.warnings.slice(0, 20);
}

export function readRaw(r: RawUpload): Buffer {
  return gzip(readFileSync(r.abs));
}
