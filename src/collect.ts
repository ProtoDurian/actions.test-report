import fg from 'fast-glob';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import { buildCoverage } from './coverage';
import { detectFormat, readHead } from './detect';
import { goModules, lsFiles, repoRoot } from './git';
import { PathResolver } from './paths';
import { parseBunConsole } from './parsers/bunconsole';
import { parseCobertura } from './parsers/cobertura';
import { parseDartJson } from './parsers/dart';
import { parseGoCover } from './parsers/gocover';
import { parseJunit } from './parsers/junit';
import { parseLcov } from './parsers/lcov';
import { parseTrx } from './parsers/trx';
import type { Coverage, FoundFile, Inputs, Language, ParsedCoverage, RawCase, TestCase } from './types';
import { errMsg, sha1hex, toPosix, truncBytes } from './util';

export interface Defaults {
  tests: string[];
  coverage: string[];
  consoleLog: string | null;
  /** directory (relative to working-directory) that holds GATE_FAILED / INACTIVE */
  testsDir: string;
}

/** CONTRACT §6 */
export function defaultGlobs(language: Language, flag: string): Defaults {
  switch (language) {
    case 'bun':
      return { tests: [`reports/${flag}/junit.xml`], coverage: [`coverage/${flag}/lcov.info`], consoleLog: `reports/${flag}/console.log`, testsDir: `reports/${flag}` };
    case 'go':
      return { tests: [`reports/${flag}/junit.xml`], coverage: [`coverage/${flag}.out`], consoleLog: null, testsDir: `reports/${flag}` };
    case 'dotnet':
      return { tests: [`TestResults/${flag}/**/*.trx`], coverage: [`TestResults/${flag}/**/coverage.cobertura.xml`], consoleLog: null, testsDir: `TestResults/${flag}` };
    case 'dart':
      return { tests: [`reports/${flag}/test.json`], coverage: [`coverage/${flag}/lcov.info`], consoleLog: null, testsDir: `reports/${flag}` };
    case 'flutter':
      return { tests: [`reports/${flag}/test.json`], coverage: ['coverage/lcov.info'], consoleLog: null, testsDir: `reports/${flag}` };
    default:
      return { tests: [], coverage: [], consoleLog: null, testsDir: `reports/${flag}` };
  }
}

export interface Collected {
  root: string;
  workDir: string;
  tracked: Map<string, string>;
  resolver: PathResolver;
  files: FoundFile[];
  cases: TestCase[] | null;
  coverage: Coverage | null;
  consoleText: string | null;
  consolePath: string | null;
  hasTestFile: boolean;
  hasCoverageFile: boolean;
  gateMarker: boolean;
  inactiveMarker: boolean;
  /** problems worth a core.warning */
  problems: string[];
  /** goes into report/summary warnings */
  warnings: string[];
  notes: string[];
}

function findFiles(workDir: string, globs: string[], problems: string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    try {
      const abs = isAbsolute(g) ? [g].filter(existsSync) : fg.sync(g, { cwd: workDir, dot: true, onlyFiles: true, absolute: true, unique: true, ignore: ['**/node_modules/**'] });
      out.push(...abs.sort());
    } catch (e) {
      problems.push(`bad glob "${g}": ${errMsg(e)}`);
    }
  }
  return [...new Set(out)];
}

export function makeId(flag: string, identity: string): string {
  return sha1hex(`${flag}|${identity}`).slice(0, 20);
}

export function finalizeCases(raw: RawCase[], flag: string, resolver: PathResolver): TestCase[] {
  const seen = new Map<string, number>();
  return raw.map(r => {
    const n = (seen.get(r.identity) ?? 0) + 1;
    seen.set(r.identity, n);
    const id = makeId(flag, n === 1 ? r.identity : `${r.identity}#${n}`);
    let file = r.file;
    if (file) {
      const candidates = r.fileBase ? [posix.join(resolver.goPackageDir(r.fileBase), file)] : [];
      file = resolver.resolve(file, { candidates, quiet: true, what: 'test file' });
    }
    return {
      id,
      suite: r.suite,
      name: r.name,
      file,
      line: r.line,
      status: r.status,
      durationMs: r.durationMs,
      message: r.message,
      stack: r.stack,
    };
  });
}

const GO_PANIC = /(^|\n)(panic: |fatal error: )/;

export function collect(inputs: Inputs, cwd: string = process.cwd()): Collected {
  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const workDir = resolve(cwd, inputs.workingDirectory || '.');
  const root = repoRoot(workDir) ?? workDir;
  const tracked = lsFiles(root);
  const resolver = new PathResolver({
    repoRoot: root,
    workDir,
    tracked: new Set(tracked.keys()),
    goModules: goModules(root, tracked.keys()),
  });
  const defs = defaultGlobs(inputs.language, inputs.flag);
  const testGlobs = inputs.tests.length ? inputs.tests : defs.tests;
  const covGlobs = inputs.coverage.length ? inputs.coverage : defs.coverage;
  if (inputs.language === 'generic' && !inputs.tests.length) problems.push('language "generic" needs the "tests" input; no test files will be read');

  const files: FoundFile[] = [];
  const seen = new Set<string>();
  for (const abs of findFiles(workDir, [...testGlobs, ...covGlobs], problems)) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const kind = detectFormat(readHead(abs));
      const rel = toPosix(relative(workDir, abs));
      if (!kind) {
        problems.push(`unrecognized report format, skipped: ${rel}`);
        continue;
      }
      files.push({ abs, rel, kind, bytes: statSync(abs).size });
    } catch (e) {
      problems.push(`cannot read ${abs}: ${errMsg(e)}`);
    }
  }

  // console log (Bun failure text, ❌ gate lines)
  let consoleText: string | null = null;
  let consolePath: string | null = null;
  const consoleRel = inputs.consoleLog || defs.consoleLog;
  if (consoleRel) {
    const abs = resolve(workDir, consoleRel);
    if (existsSync(abs)) {
      try {
        consoleText = readFileSync(abs, 'utf8');
        consolePath = abs;
        files.push({ abs, rel: toPosix(relative(workDir, abs)), kind: 'console', bytes: statSync(abs).size });
      } catch (e) {
        problems.push(`cannot read console log ${consoleRel}: ${errMsg(e)}`);
      }
    } else if (inputs.consoleLog) {
      problems.push(`console-log not found: ${consoleRel}`);
    }
  }

  // tests
  const raw: RawCase[] = [];
  const testFiles = files.filter(f => f.kind === 'junit' || f.kind === 'trx' || f.kind === 'dart-json');
  for (const f of testFiles) {
    try {
      const text = readFileSync(f.abs, 'utf8');
      const parsed =
        f.kind === 'junit'
          ? parseJunit(text, { language: inputs.language, goPackage: p => resolver.goPackageDir(p) })
          : f.kind === 'trx'
            ? parseTrx(text)
            : parseDartJson(text);
      raw.push(...parsed.cases);
      for (const w of parsed.warnings) problems.push(`${f.rel}: ${w}`);
    } catch (e) {
      problems.push(`cannot parse ${f.rel} as ${f.kind}: ${errMsg(e)}`);
    }
  }
  if (consoleText && inputs.language === 'bun') attachBunConsole(raw, consoleText);

  const cases = testFiles.length ? finalizeCases(raw, inputs.flag, resolver) : null;

  // coverage
  const parsedCov: ParsedCoverage[] = [];
  const covFiles = files.filter(f => f.kind === 'lcov' || f.kind === 'cobertura' || f.kind === 'goprofile');
  for (const f of covFiles) {
    try {
      const text = readFileSync(f.abs, 'utf8');
      const p = f.kind === 'lcov' ? parseLcov(text) : f.kind === 'cobertura' ? parseCobertura(text) : parseGoCover(text);
      parsedCov.push(p);
      for (const w of p.warnings) warnings.push(`${f.rel}: ${w}`);
    } catch (e) {
      problems.push(`cannot parse ${f.rel} as ${f.kind}: ${errMsg(e)}`);
    }
  }
  const coverage = buildCoverage(parsedCov, resolver);
  if (coverage) {
    const formats = new Set(parsedCov.map(p => p.format));
    if (formats.size > 1) notes.push(`coverage files of several formats were merged (${[...formats].join(', ')})`);
    const failing = (cases ?? []).filter(c => c.status === 'failed' || c.status === 'errored');
    const panicked = failing.some(c => GO_PANIC.test(c.message ?? '') || GO_PANIC.test(c.stack ?? ''));
    if (coverage.format === 'go' || inputs.language === 'go') {
      if (panicked) {
        coverage.partial = true;
        notes.push('coverage partial: a test binary panicked (go)');
      } else if (parsedCov.every(p => p.files.size === 0) && failing.length) {
        coverage.partial = true;
        notes.push('coverage partial: the Go coverage profile is empty although tests failed');
      }
    }
  }

  // markers
  const dir = resolve(workDir, defs.testsDir);
  const gateMarker = existsSync(join(dir, 'GATE_FAILED'));
  const inactiveMarker = existsSync(join(dir, 'INACTIVE'));

  warnings.push(...resolver.allWarnings());
  return {
    root,
    workDir,
    tracked,
    resolver,
    files,
    cases,
    coverage,
    consoleText,
    consolePath,
    hasTestFile: testFiles.length > 0,
    hasCoverageFile: covFiles.length > 0,
    gateMarker,
    inactiveMarker,
    problems,
    warnings,
    notes,
  };
}

/** Bun's JUnit has no failure text: take it from the console block before each `(fail)` line. */
export function attachBunConsole(raw: RawCase[], consoleText: string): void {
  const byName = parseBunConsole(consoleText);
  for (const c of raw) {
    if (c.status !== 'failed' && c.status !== 'errored') continue;
    const list = c.consoleKey ? byName.get(c.consoleKey) : undefined;
    const hit = list?.shift();
    if (hit && (hit.message || hit.stack)) {
      c.message = hit.message || c.message;
      c.stack = hit.stack;
    }
  }
}

export const capText = (c: { message: string | null; stack: string | null }): void => {
  if (c.message) c.message = truncBytes(c.message, 4096);
  if (c.stack) c.stack = truncBytes(c.stack, 16384);
};
