import type { FileCoverage, ParsedCoverage } from '../types';

export const newFile = (): FileCoverage => ({ lines: new Map(), branches: new Map() });

export function parseLcov(text: string): ParsedCoverage {
  const files = new Map<string, FileCoverage>();
  let cur: FileCoverage | null = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) {
      const p = l.slice(3);
      cur = files.get(p) ?? newFile();
      files.set(p, cur);
    } else if (!cur) {
      continue;
    } else if (l.startsWith('DA:')) {
      const [ln, hits] = l.slice(3).split(',');
      const n = Number(ln);
      const h = Number(hits);
      if (Number.isFinite(n) && Number.isFinite(h)) cur.lines.set(n, (cur.lines.get(n) ?? 0) + h);
    } else if (l.startsWith('BRDA:')) {
      const [ln, , , taken] = l.slice(5).split(',');
      const n = Number(ln);
      if (!Number.isFinite(n)) continue;
      const b = cur.branches.get(n) ?? [0, 0];
      b[1] += 1;
      if (taken !== '-' && Number(taken) > 0) b[0] += 1;
      cur.branches.set(n, b);
    } else if (l === 'end_of_record') {
      cur = null;
    }
  }
  return { format: 'lcov', files, sources: [], warnings: [] };
}
