import { describe, expect, test } from 'bun:test';
import { PathResolver } from '../src/paths';

const mk = (tracked: string[], over: Partial<ConstructorParameters<typeof PathResolver>[0]> = {}) =>
  new PathResolver({ repoRoot: '/work/repo', workDir: '/work/repo', tracked: new Set(tracked), goModules: [], ...over });

describe('path normalization', () => {
  test('absolute path under the repo root becomes repo-relative', () => {
    const r = mk(['src/a.ts']);
    expect(r.resolve('/work/repo/src/a.ts')).toBe('src/a.ts');
    expect(r.allWarnings()).toEqual([]);
  });
  test('./ and backslashes are normalized to POSIX', () => {
    const r = mk(['src/a.ts']);
    expect(r.resolve('./src/a.ts')).toBe('src/a.ts');
    expect(r.resolve('src\\a.ts')).toBe('src/a.ts');
  });
  test('file:// URLs are unwrapped', () => {
    expect(mk(['test/m_test.dart']).resolve('file:///work/repo/test/m_test.dart')).toBe('test/m_test.dart');
  });
  test('working-directory relative paths are joined onto the repo root', () => {
    const r = mk(['apps/web/src/a.ts'], { workDir: '/work/repo/apps/web' });
    expect(r.resolve('src/a.ts')).toBe('apps/web/src/a.ts');
  });
  test('Cobertura: source "/" + absolute-minus-slash filename resolves by tracked suffix', () => {
    const r = mk(['Lib/Class1.cs']);
    expect(r.resolve('tmp/build/x/Lib/Class1.cs', { bases: ['/'] })).toBe('Lib/Class1.cs');
  });
  test('Cobertura: source directory is tried as a base', () => {
    const r = mk(['Lib/Class1.cs']);
    expect(r.resolve('Class1.cs', { bases: ['/work/repo/Lib'] })).toBe('Lib/Class1.cs');
  });
  test('/nix/store noise is stripped when the remainder is tracked', () => {
    const r = mk(['src/a.go']);
    expect(r.resolve('/nix/store/' + 'a'.repeat(32) + '-source/src/a.go')).toBe('src/a.go');
  });
  test('a CI runner path outside the repo root falls back to the tracked suffix', () => {
    const r = mk(['lib/src/m.dart']);
    expect(r.resolve('/home/runner/work/x/x/lib/src/m.dart')).toBe('lib/src/m.dart');
  });
  test('Go import path → module-relative via the go.mod module line', () => {
    const r = mk(['calc/calc.go'], { goModules: [{ dir: '', module: 'example.com/spike' }] });
    expect(r.resolve('example.com/spike/calc/calc.go', { go: true })).toBe('calc/calc.go');
  });
  test('Go module in a sub directory', () => {
    const r = mk(['services/api/calc/calc.go'], { goModules: [{ dir: 'services/api', module: 'example.com/api' }] });
    expect(r.resolve('example.com/api/calc/calc.go', { go: true })).toBe('services/api/calc/calc.go');
    expect(r.goPackageDir('example.com/api/calc')).toBe('services/api/calc');
  });
  test('Go test failure files are resolved against the package dir candidate', () => {
    const r = mk(['calc/calc_test.go'], { goModules: [{ dir: '', module: 'example.com/spike' }] });
    expect(r.resolve('calc_test.go', { candidates: [r.goPackageDir('example.com/spike/calc') + '/calc_test.go'] })).toBe('calc/calc_test.go');
  });
  test('untracked paths are kept and produce a warning once', () => {
    const r = mk(['src/a.ts']);
    expect(r.resolve('/opt/other/x.ts', { what: 'coverage path' })).toBe('/opt/other/x.ts');
    r.resolve('/opt/other/x.ts', { what: 'coverage path' });
    expect(r.allWarnings()).toEqual(['coverage path not tracked by git: /opt/other/x.ts']);
  });
  test('no warnings when git ls-files is unavailable (nothing to compare with)', () => {
    const r = mk([]);
    expect(r.resolve('src/a.ts')).toBe('src/a.ts');
    expect(r.allWarnings()).toEqual([]);
  });
  test('warnings are capped', () => {
    const r = mk(['a']);
    for (let i = 0; i < 80; i++) r.resolve(`/x/${i}.ts`);
    const w = r.allWarnings();
    expect(w.length).toBe(51);
    expect(w.at(-1)).toMatch(/30 more/);
  });
});
