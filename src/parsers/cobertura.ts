import type { ParsedCoverage } from '../types';
import { asArray } from '../util';
import { newFile } from './lcov';
import { parseXml } from './xml';

export function parseCobertura(text: string): ParsedCoverage {
  const doc = parseXml(text);
  const cov = doc.coverage ?? {};
  const sources: string[] = asArray(cov.sources?.source).map((s: unknown) =>
    typeof s === 'string' ? s : String((s as Record<string, unknown>)['#text'] ?? ''),
  );
  const files = new Map<string, ReturnType<typeof newFile>>();
  for (const pkg of asArray(cov.packages?.package)) {
    for (const cls of asArray(pkg.classes?.class)) {
      const filename: string | undefined = cls['@_filename'];
      if (!filename) continue;
      const f = files.get(filename) ?? newFile();
      files.set(filename, f);
      // one file = one measurement: max per line (classes of one file can overlap on compiler-generated lines)
      for (const ln of asArray(cls.lines?.line)) {
        const n = Number(ln['@_number']);
        const hits = Number(ln['@_hits'] ?? 0);
        if (!Number.isFinite(n)) continue;
        f.lines.set(n, Math.max(f.lines.get(n) ?? 0, hits));
        const cc = /\((\d+)\/(\d+)\)/.exec(ln['@_condition-coverage'] ?? '');
        if (cc) {
          const prev = f.branches.get(n);
          const hit = Number(cc[1]);
          const total = Number(cc[2]);
          f.branches.set(n, prev ? [Math.max(prev[0], hit), Math.max(prev[1], total)] : [hit, total]);
        }
      }
    }
  }
  return { format: 'cobertura', files, sources: sources.filter(Boolean), warnings: [] };
}
