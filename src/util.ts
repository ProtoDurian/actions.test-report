import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const sha1hex = (s: string | Uint8Array): string => createHash('sha1').update(s).digest('hex');

export const gzip = (data: string | Uint8Array): Buffer => gzipSync(data, { level: 9 });

export const toPosix = (p: string): string => p.replace(/\\/g, '/');

export const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Truncate to at most `max` UTF-8 bytes, marking the cut. */
export function truncBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const mark = '\n…[truncated]';
  const keep = Math.max(0, max - Buffer.byteLength(mark, 'utf8'));
  let cut = Buffer.from(s, 'utf8').subarray(0, keep).toString('utf8');
  while (cut.endsWith('�')) cut = cut.slice(0, -1);
  return cut + mark;
}

export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

export const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function pct(hit: number, total: number): string {
  if (total <= 0) return 'n/a';
  return `${((hit / total) * 100).toFixed(1)}%`;
}
