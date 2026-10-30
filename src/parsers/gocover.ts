import type { ParsedCoverage } from '../types';
import { newFile } from './lcov';

/**
 * Go coverprofile -> line coverage. A block `file:l1.c1,l2.c2 stmts count` marks lines l1..l2;
 * where blocks overlap on a line, the line is hit if any block there was hit (max count).
 * Paths are import paths (module-prefixed); the caller maps them to the repo.
 */
export function parseGoCover(text: string): ParsedCoverage {
  const files = new Map<string, ReturnType<typeof newFile>>();
  const warnings: string[] = [];
  let blocks = 0;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('mode:')) continue;
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(l);
    if (!m) continue;
    blocks++;
    const f = files.get(m[1]!) ?? newFile();
    files.set(m[1]!, f);
    const count = Number(m[5]);
    for (let n = Number(m[2]); n <= Number(m[3]); n++) f.lines.set(n, Math.max(f.lines.get(n) ?? 0, count));
  }
  if (blocks === 0) warnings.push('go coverage profile has no blocks');
  return { format: 'go', files, sources: [], warnings };
}
