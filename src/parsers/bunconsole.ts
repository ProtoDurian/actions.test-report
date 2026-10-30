import { stripAnsi } from '../util';

export interface ConsoleFailure {
  message: string;
  stack: string | null;
}

const MARKER = /^\((pass|fail|skip|todo)\) /;
const FILE_HEADER = /^\S.*\.(?:[cm]?[jt]sx?):$/;
const STACK_LINE = /^\s+at /;
const TIMING = /\s+\[[\d.]+m?s\]\s*$/;

/**
 * Bun prints each failure's source snippet, `error: …` message and stack to stderr, then `(fail) <describe > name>`.
 * Returns the block that ends at each `(fail)` line, keyed by the full test name (` > `-joined).
 */
export function parseBunConsole(text: string): Map<string, ConsoleFailure[]> {
  const out = new Map<string, ConsoleFailure[]>();
  let block: string[] = [];
  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (MARKER.test(line)) {
      if (line.startsWith('(fail) ')) {
        const name = line.slice(7).replace(TIMING, '').trim();
        const list = out.get(name) ?? [];
        list.push(toFailure(block));
        out.set(name, list);
      }
      block = [];
    } else if (FILE_HEADER.test(line)) {
      block = [];
    } else {
      block.push(line);
    }
  }
  return out;
}

function toFailure(lines: string[]): ConsoleFailure {
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  const errAt = lines.findIndex(l => /^(error|\w*Error)\b.*:|^error\b/.test(l));
  const body = errAt >= 0 ? lines.slice(errAt) : lines.filter(l => !/^\s*\d+ \|/.test(l) && !/^\s*\^+\s*$/.test(l));
  const stackAt = body.findIndex(l => STACK_LINE.test(l));
  const msgLines = stackAt >= 0 ? body.slice(0, stackAt) : body;
  const stackLines = stackAt >= 0 ? body.slice(stackAt) : [];
  const message = msgLines.join('\n').trim().replace(/^error: /, '');
  return { message, stack: stackLines.length ? stackLines.map(l => l.trimEnd()).join('\n').trim() : null };
}
