import type { Language, ParsedTests, RawCase } from '../types';
import { asArray } from '../util';
import { parseXml, textOf, type XNode } from './xml';
import { cleanGoOutput, goLocation } from './golog';

export interface JunitOpts {
  language: Language;
  /** maps a Go package (classname) to its repo-relative dir; identity keeps the import path otherwise */
  goPackage?: (classname: string) => string;
}

interface Ctx {
  /** describe path (nested testsuite names, file-level suite excluded) */
  path: string[];
  fileSuite: string | null;
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseJunit(text: string, opts: JunitOpts): ParsedTests {
  const doc = parseXml(text);
  const cases: RawCase[] = [];
  const roots: XNode[] = [...asArray(doc.testsuites?.testsuite), ...asArray(doc.testsuite)];
  for (const s of roots) walk(s, { path: [], fileSuite: null }, opts, cases);
  return { cases, warnings: [] };
}

function walk(suite: XNode, ctx: Ctx, opts: JunitOpts, out: RawCase[]): void {
  const name: string = suite['@_name'] ?? '';
  const file: string | undefined = suite['@_file'];
  // Bun: the outer suite is the file itself (name == file, no line) — not part of the describe path.
  const isFileSuite = opts.language === 'bun' && ctx.path.length === 0 && !!file && name === file && suite['@_line'] === undefined;
  const next: Ctx = isFileSuite
    ? { path: ctx.path, fileSuite: file ?? null }
    : { path: opts.language === 'bun' ? [...ctx.path, name] : ctx.path, fileSuite: ctx.fileSuite };
  for (const tc of asArray(suite.testcase)) out.push(toCase(tc, suite, next, opts));
  for (const child of asArray(suite.testsuite)) walk(child, next, opts, out);
}

function toCase(tc: XNode, suite: XNode, ctx: Ctx, opts: JunitOpts): RawCase {
  const name: string = tc['@_name'] ?? '';
  const classname: string = tc['@_classname'] ?? '';
  const failures = asArray(tc.failure);
  const errors = asArray(tc.error);
  const skipped = tc.skipped !== undefined;
  const bad = failures.length ? failures : errors;
  const status = failures.length ? 'failed' : errors.length ? 'errored' : skipped ? 'skipped' : 'passed';

  let message: string | null = null;
  let stack: string | null = null;
  let file: string | null = tc['@_file'] ?? suite['@_file'] ?? ctx.fileSuite ?? null;
  let line = num(tc['@_line']);
  let fileBase: string | null = null;

  if (status === 'failed' || status === 'errored') {
    const parts = bad.map(b => {
      const attr: string = typeof b === 'object' ? (b['@_message'] ?? '') : '';
      const body = textOf(b).trim();
      const type: string = typeof b === 'object' ? (b['@_type'] ?? '') : '';
      return { attr, body, type };
    });
    const body = parts.map(p => p.body).filter(Boolean).join('\n\n');
    const attr = parts.map(p => p.attr).filter(Boolean).join('\n');
    const type = parts.map(p => p.type).find(Boolean) ?? '';
    if (opts.language === 'go') {
      const cleaned = cleanGoOutput(body || attr);
      message = cleaned.message || attr || 'test failed';
      stack = cleaned.stack;
      const loc = goLocation(cleaned.message, cleaned.stack);
      if (loc) {
        file = loc.file;
        line = loc.line;
        fileBase = loc.absolute ? null : classname;
      }
    } else {
      message = body || attr || type || null;
      if (body && attr && !body.includes(attr)) message = `${attr}\n${body}`;
      if (!body && attr && type && !attr.includes(type)) message = `${type}: ${attr}`;
    }
  } else if (opts.language === 'go') {
    file = null;
  }

  let identity: string;
  let suiteName = classname;
  if (opts.language === 'go') {
    const pkg = opts.goPackage ? opts.goPackage(classname) : classname;
    identity = `${classname}.${name}`;
    suiteName = pkg;
  } else if (opts.language === 'bun') {
    const describe = ctx.path.join(' > ');
    suiteName = describe || classname || ctx.fileSuite || '';
    identity = `${suiteName}::${name}`;
  } else {
    identity = `${classname}::${name}`;
  }

  return {
    identity,
    consoleKey: opts.language === 'bun' ? [...ctx.path, name].join(' > ') : undefined,
    suite: suiteName,
    name,
    file,
    fileBase,
    line,
    status,
    durationMs: Math.round((num(tc['@_time']) ?? 0) * 1000),
    message,
    stack,
  };
}
