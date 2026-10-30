import { describe, expect, test } from 'bun:test';
import { buildCoverage, chunkCoverage, computePatch, coverageTotals, fileLineStats, mergeFile } from '../src/coverage';
import { parseDiff } from '../src/diff';
import { newFile } from '../src/parsers/lcov';
import { PathResolver } from '../src/paths';
import type { Coverage, FileCoverage, ParsedCoverage } from '../src/types';

const fc = (lines: [number, number][], branches: [number, [number, number]][] = []): FileCoverage => ({
  lines: new Map(lines),
  branches: new Map(branches),
});
const resolver = (tracked: string[] = []) =>
  new PathResolver({ repoRoot: '/r', workDir: '/r', tracked: new Set(tracked), goModules: [] });
const parsed = (files: Record<string, FileCoverage>, sources: string[] = []): ParsedCoverage => ({
  format: 'lcov',
  files: new Map(Object.entries(files)),
  sources,
  warnings: [],
});

describe('merge', () => {
  test('hits are summed per file and line', () => {
    const a = fc([[1, 1], [2, 0]]);
    mergeFile(a, fc([[1, 2], [2, 0], [3, 5]]));
    expect([...a.lines]).toEqual([[1, 3], [2, 0], [3, 5]]);
  });
  test('branches: taken is summed, capped at the total', () => {
    const a = fc([], [[1, [1, 2]]]);
    mergeFile(a, fc([], [[1, [2, 2]], [4, [0, 2]]]));
    expect(a.branches.get(1)).toEqual([2, 2]);
    expect(a.branches.get(4)).toEqual([0, 2]);
  });
  test('two files of one kind are merged by buildCoverage (same path after normalization)', () => {
    const cov = buildCoverage(
      [parsed({ 'src/a.ts': fc([[1, 1], [2, 0]]) }), parsed({ './src/a.ts': fc([[1, 1], [2, 4]]), 'src/b.ts': fc([[1, 0]]) })],
      resolver(['src/a.ts', 'src/b.ts']),
    )!;
    expect([...cov.files.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect([...cov.files.get('src/a.ts')!.lines]).toEqual([[1, 2], [2, 4]]);
  });
  test('no inputs → null', () => {
    expect(buildCoverage([], resolver())).toBeNull();
  });
});

describe('totals', () => {
  const cov: Coverage = {
    format: 'lcov',
    partial: false,
    files: new Map([
      ['a', fc([[1, 1], [2, 0], [3, 2]], [[2, [1, 2]]])],
      ['b', fc([[1, 0]])],
    ]),
  };
  test('lines and branches', () => {
    expect(coverageTotals(cov)).toEqual({ lines: 4, linesHit: 2, branches: 2, branchesHit: 1 });
    expect(fileLineStats(cov.files.get('a')!)).toEqual({ lines: 3, hit: 2 });
  });
  test('branches are null when no file has branch data', () => {
    const c2: Coverage = { ...cov, files: new Map([['b', fc([[1, 0]])]]) };
    expect(coverageTotals(c2)).toMatchObject({ branches: null, branchesHit: null });
  });
});

describe('chunking (≤200 files / ~1 MB per diene-cov/v1 chunk)', () => {
  const many = (n: number): Coverage => ({
    format: 'lcov',
    partial: false,
    files: new Map(Array.from({ length: n }, (_, i) => [`src/f${String(i).padStart(4, '0')}.ts`, fc([[1, 1]])] as const)),
  });
  test('201 files → 2 chunks, index recorded per path', () => {
    const { chunks, chunkOf } = chunkCoverage(many(201));
    expect(chunks.length).toBe(2);
    expect(Object.keys(chunks[0]!.files).length).toBe(200);
    expect(chunks[0]!.schema).toBe('diene-cov/v1');
    expect(chunkOf.get('src/f0000.ts')).toBe(0);
    expect(chunkOf.get('src/f0200.ts')).toBe(1);
  });
  test('a large file set splits by size', () => {
    const big = fc(Array.from({ length: 60_000 }, (_, i) => [i + 1, 1] as [number, number]));
    const cov: Coverage = { format: 'lcov', partial: false, files: new Map([['a', big], ['b', big], ['c', big]]) };
    const { chunks } = chunkCoverage(cov);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(Buffer.byteLength(JSON.stringify(ch))).toBeLessThan(1_300_000);
  });
  test('wire shape: lines [[n,hits]], branches [[line,hit,total]] or null', () => {
    const cov: Coverage = { format: 'lcov', partial: false, files: new Map([['a', fc([[2, 0], [1, 3]], [[2, [1, 2]]])], ['b', fc([[1, 1]])]]) };
    const { chunks } = chunkCoverage(cov);
    expect(chunks[0]!.files.a).toEqual({ lines: [[1, 3], [2, 0]], branches: [[2, 1, 2]] });
    expect(chunks[0]!.files.b!.branches).toBeNull();
  });
  test('empty coverage → no chunks', () => {
    expect(chunkCoverage({ format: 'lcov', partial: false, files: new Map() }).chunks).toEqual([]);
  });
});

describe('diff + patch coverage', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,2 @@',
    '+x',
    '+y',
    '@@ -10 +12 @@',
    '-old',
    '+new',
    '@@ -20,2 +22,0 @@',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,3 @@',
  ].join('\n');
  test('parseDiff returns new-side lines, ignores pure deletions and deleted files', () => {
    const d = parseDiff(diff);
    expect(d.get('src/a.ts')).toEqual([2, 3, 12]);
    expect(d.get('src/new.ts')).toEqual([1, 2, 3]);
    expect(d.has('gone.ts')).toBe(false);
  });
  test('only coverable changed lines count; uncovered lines are listed', () => {
    const cov: Coverage = {
      format: 'lcov',
      partial: false,
      files: new Map([['src/a.ts', fc([[2, 1], [3, 0], [5, 1]])]]),
    };
    expect(computePatch(cov, parseDiff(diff))).toEqual({
      lines: 2,
      hit: 1,
      files: [{ path: 'src/a.ts', lines: 2, hit: 1, uncovered: [3] }],
    });
  });
  test('files without coverage data are ignored', () => {
    const cov: Coverage = { format: 'lcov', partial: false, files: new Map() };
    expect(computePatch(cov, parseDiff(diff))).toEqual({ lines: 0, hit: 0, files: [] });
  });
});

test('newFile creates empty line/branch maps', () => {
  const f = newFile();
  expect(f.lines.size + f.branches.size).toBe(0);
});
