import { openSync, readSync, closeSync } from 'node:fs';
import type { RawKind } from './types';
import { stripBom } from './util';

/** Format from content, never from the extension (CONTRACT §6). */
export function detectFormat(head: string): RawKind | null {
  const s = stripBom(head).trimStart();
  if (!s) return null;
  if (s.startsWith('<')) {
    const m = /<(?![?!])([A-Za-z_][\w.:-]*)/.exec(s);
    const root = m?.[1]?.replace(/^.*:/, '');
    if (root === 'testsuites' || root === 'testsuite') return 'junit';
    if (root === 'TestRun') return 'trx';
    if (root === 'coverage') return 'cobertura';
    return null;
  }
  if (s.startsWith('{')) {
    const first = s.split('\n', 1)[0]!;
    if (first.includes('"protocolVersion"') || first.includes('"type":"start"') || first.includes('"type": "start"')) return 'dart-json';
    return null;
  }
  if (s.startsWith('mode: ')) return 'goprofile';
  if (/^(TN:|SF:)/m.test(s)) return 'lcov';
  return null;
}

export function readHead(abs: string, n = 4096): string {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
