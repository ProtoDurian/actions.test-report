export type Language = 'bun' | 'go' | 'dotnet' | 'dart' | 'flutter' | 'generic';
export type TestStatus = 'passed' | 'failed' | 'errored' | 'skipped';
export type OutcomeClass =
  | 'passed'
  | 'tests_failed'
  | 'errored'
  | 'cancelled'
  | 'timed_out'
  | 'no_report'
  | 'inactive';
export type SubReason = 'gate' | 'setup' | 'crash';
export type TestFormat = 'junit' | 'trx' | 'dart-json';
export type CoverageFormat = 'lcov' | 'cobertura' | 'go';
export type RawKind = 'junit' | 'trx' | 'dart-json' | 'lcov' | 'cobertura' | 'goprofile' | 'console';

export interface TestCase {
  id: string;
  suite: string;
  name: string;
  file: string | null;
  line: number | null;
  status: TestStatus;
  durationMs: number;
  message: string | null;
  stack: string | null;
}

/** A case as a parser emits it, before ids and paths are final. */
export interface RawCase {
  /** Native identity per CONTRACT §3 (flag is mixed in later). */
  identity: string;
  suite: string;
  name: string;
  file: string | null;
  /** Directory a bare `file` is relative to (Go: the package dir; or an import path to map). */
  fileBase?: string | null;
  /** Bun: full `describe > name` as printed on the `(fail)` console line */
  consoleKey?: string;
  line: number | null;
  status: TestStatus;
  durationMs: number;
  message: string | null;
  stack: string | null;
}

export interface ParsedTests {
  cases: RawCase[];
  warnings: string[];
  /** why the run could not finish (load/compile failure, crashed test host); shown as outcome notes */
  crashReasons?: string[];
}

export interface FileCoverage {
  /** line -> hits */
  lines: Map<number, number>;
  /** line -> [taken, total] */
  branches: Map<number, [number, number]>;
}

export interface ParsedCoverage {
  format: CoverageFormat;
  /** keyed by the path exactly as the tool wrote it (not normalized yet) */
  files: Map<string, FileCoverage>;
  /** directories the tool says its paths are relative to (Cobertura <sources>) */
  sources: string[];
  warnings: string[];
}

export interface Coverage {
  format: CoverageFormat;
  files: Map<string, FileCoverage>;
  partial: boolean;
}

export interface FoundFile {
  abs: string;
  /** path relative to the working directory, POSIX */
  rel: string;
  kind: RawKind;
  bytes: number;
}

export interface Inputs {
  mode: 'start' | 'finish';
  flag: string;
  language: Language;
  tests: string[];
  coverage: string[];
  consoleLog: string;
  workingDirectory: string;
  testOutcome: string;
  jobStatus: string;
  /** null → not set by the caller (finish falls back to the state file, then 30) */
  timeoutMinutes: number | null;
  endpoint: string;
}

export interface Outcome {
  testStep: string | null;
  jobStatus: string | null;
  class: OutcomeClass;
  subReason: SubReason | null;
  jobFailedAfterTests: boolean;
  startedAt: string | null;
  finishedAt: string;
  notes: string[];
}

export interface FailureEntry {
  id: string;
  suite: string;
  name: string;
  file: string | null;
  line: number | null;
  status: 'failed' | 'errored';
  durationMs: number;
  message: string;
  stack: string | null;
}

export interface TestTotals {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  durationMs: number;
}

export interface CovTotals {
  lines: number;
  linesHit: number;
  branches: number | null;
  branchesHit: number | null;
}

export interface PatchFile {
  path: string;
  lines: number;
  hit: number;
  uncovered: number[];
}

export interface SummaryDoc {
  schema: 'diene-summary/v1';
  context: {
    sha: string;
    runId: number;
    runAttempt: number;
    headSha: string | null;
    pr: number | null;
    baseRef: string | null;
    baseSha: string | null;
    workflow: string;
    job: string;
    flag: string;
    language: Language;
    tool: string | null;
    timeoutMinutes: number;
  };
  outcome: Outcome;
  tests: null | {
    totals: TestTotals;
    failures: FailureEntry[];
    failuresTruncated: boolean;
    recovered: string[];
  };
  coverage: null | {
    format: CoverageFormat;
    totals: CovTotals;
    partial: boolean;
    files: { path: string; lines: number; hit: number; chunk: number }[];
  };
  patch: null | { lines: number; hit: number; files: PatchFile[] };
  sources: { path: string; blob: string; bytes: number }[];
  raw: { name: string; kind: RawKind; bytes: number }[];
  warnings: string[];
  overCap: boolean;
}

export interface CovChunk {
  schema: 'diene-cov/v1';
  files: Record<string, { lines: [number, number][]; branches: [number, number, number][] | null }>;
}

export interface ReportDoc {
  schema: 'diene-report/v1';
  context: Record<string, unknown>;
  outcome: Outcome & { timeoutMinutes: number };
  tests: null | { totals: TestTotals; cases: TestCase[] };
  coverage: null | {
    format: CoverageFormat;
    totals: CovTotals;
    partial: boolean;
    files: { path: string; lines: [number, number][]; branches: [number, number, number][] | null }[];
  };
  diff: null | { files: Record<string, number[]> };
  sources: { path: string; blob: string }[];
  raw: { name: string; kind: RawKind; bytes: number }[];
  warnings: string[];
}
