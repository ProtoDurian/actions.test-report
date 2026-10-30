import type { Coverage, CovChunk, CovTotals, FileCoverage, ParsedCoverage, PatchFile } from './types';
import { jsonBytes } from './util';
import type { PathResolver } from './paths';

export function mergeFile(into: FileCoverage, from: FileCoverage): void {
  for (const [n, h] of from.lines) into.lines.set(n, (into.lines.get(n) ?? 0) + h);
  for (const [n, [hit, total]] of from.branches) {
    const cur = into.branches.get(n);
    // the same branch may be reported by several files: take the larger hit count (a safe lower bound), never the sum
    into.branches.set(n, cur ? [Math.max(cur[0], hit), Math.max(cur[1], total)] : [hit, total]);
  }
}

/** Resolve every path, then merge parsed files of any format: line hits are summed per file/line. */
export function buildCoverage(parsed: ParsedCoverage[], resolver: PathResolver): Coverage | null {
  if (!parsed.length) return null;
  const files = new Map<string, FileCoverage>();
  for (const p of parsed) {
    for (const [path, fc] of p.files) {
      const rel = resolver.resolve(path, { bases: p.sources, go: p.format === 'go', what: 'coverage path' });
      const cur = files.get(rel) ?? { lines: new Map(), branches: new Map() };
      files.set(rel, cur);
      mergeFile(cur, fc);
    }
  }
  const formats = parsed.map(p => p.format);
  return { format: formats[0]!, files, partial: false };
}

export function fileLineStats(fc: FileCoverage): { lines: number; hit: number } {
  let hit = 0;
  for (const h of fc.lines.values()) if (h > 0) hit++;
  return { lines: fc.lines.size, hit };
}

export function coverageTotals(cov: Coverage): CovTotals {
  let lines = 0;
  let linesHit = 0;
  let branches = 0;
  let branchesHit = 0;
  let anyBranch = false;
  for (const fc of cov.files.values()) {
    const s = fileLineStats(fc);
    lines += s.lines;
    linesHit += s.hit;
    for (const [hit, total] of fc.branches.values()) {
      anyBranch = true;
      branches += total;
      branchesHit += hit;
    }
  }
  return { lines, linesHit, branches: anyBranch ? branches : null, branchesHit: anyBranch ? branchesHit : null };
}

export const sortedLines = (fc: FileCoverage): [number, number][] => [...fc.lines].sort((a, b) => a[0] - b[0]);

export const sortedBranches = (fc: FileCoverage): [number, number, number][] | null =>
  fc.branches.size ? [...fc.branches].sort((a, b) => a[0] - b[0]).map(([l, [h, t]]) => [l, h, t]) : null;

export const CHUNK_MAX_FILES = 200;
export const CHUNK_MAX_BYTES = 1_000_000;

/** Split into `diene-cov/v1` chunks (≤200 files and ~1 MB each); returns the chunk index per path. */
export function chunkCoverage(cov: Coverage): { chunks: CovChunk[]; chunkOf: Map<string, number> } {
  const chunks: CovChunk[] = [];
  const chunkOf = new Map<string, number>();
  let cur: CovChunk = { schema: 'diene-cov/v1', files: {} };
  let curBytes = 0;
  let curCount = 0;
  const flush = (): void => {
    if (curCount) chunks.push(cur);
    cur = { schema: 'diene-cov/v1', files: {} };
    curBytes = 0;
    curCount = 0;
  };
  for (const path of [...cov.files.keys()].sort()) {
    const fc = cov.files.get(path)!;
    const entry = { lines: sortedLines(fc), branches: sortedBranches(fc) };
    const size = jsonBytes(entry) + path.length + 8;
    if (curCount > 0 && (curCount >= CHUNK_MAX_FILES || curBytes + size > CHUNK_MAX_BYTES)) flush();
    cur.files[path] = entry;
    curBytes += size;
    curCount++;
    chunkOf.set(path, chunks.length);
  }
  flush();
  return { chunks, chunkOf };
}

export function computePatch(
  cov: Coverage,
  diff: Map<string, number[]>,
): { lines: number; hit: number; files: PatchFile[] } {
  let lines = 0;
  let hit = 0;
  const files: PatchFile[] = [];
  for (const [path, changed] of [...diff].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fc = cov.files.get(path);
    if (!fc) continue;
    let l = 0;
    let h = 0;
    const uncovered: number[] = [];
    for (const n of changed) {
      const hits = fc.lines.get(n);
      if (hits === undefined) continue;
      l++;
      if (hits > 0) h++;
      else uncovered.push(n);
    }
    if (l === 0) continue;
    lines += l;
    hit += h;
    files.push({ path, lines: l, hit: h, uncovered });
  }
  return { lines, hit, files };
}
