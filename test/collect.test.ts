import { describe, expect, test } from 'bun:test';
import { collect, defaultGlobs, finalizeCases, makeId } from '../src/collect';
import { PathResolver } from '../src/paths';
import type { RawCase } from '../src/types';
import { fixture, inputs, tmpRepo, write } from './helpers';

const raw = (over: Partial<RawCase> = {}): RawCase => ({
  identity: 'math::adds',
  suite: 'math',
  name: 'adds',
  file: 'tests/m.test.ts',
  line: 4,
  status: 'passed',
  durationMs: 0,
  message: null,
  stack: null,
  ...over,
});
const resolver = () => new PathResolver({ repoRoot: '/r', workDir: '/r', tracked: new Set(), goModules: [] });

describe('test ids (CONTRACT §3)', () => {
  test('first 20 hex chars of sha1(flag|identity)', () => {
    const id = makeId('unit', 'math::adds');
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    expect(id).toBe(new Bun.CryptoHasher('sha1').update('unit|math::adds').digest('hex').slice(0, 20));
  });
  test('stable across runs and independent of file / line / status / message', () => {
    const [a] = finalizeCases([raw()], 'unit', resolver());
    const [b] = finalizeCases([raw({ file: 'moved/elsewhere.ts', line: 99, status: 'failed', message: 'x', durationMs: 5 })], 'unit', resolver());
    expect(a!.id).toBe(b!.id);
  });
  test('depends on the flag', () => {
    const [a] = finalizeCases([raw()], 'unit', resolver());
    const [b] = finalizeCases([raw()], 'integration', resolver());
    expect(a!.id).not.toBe(b!.id);
  });
  test('duplicate identities get a #n suffix so ids stay unique and deterministic', () => {
    const ids = finalizeCases([raw(), raw(), raw()], 'unit', resolver()).map(c => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe(makeId('unit', 'math::adds'));
    expect(ids[1]).toBe(makeId('unit', 'math::adds#2'));
  });
});

describe('default globs (CONTRACT §6)', () => {
  test.each([
    ['bun', 'reports/u/junit.xml', 'coverage/u/lcov.info', 'reports/u/console.log', 'reports/u'],
    ['go', 'reports/u/junit.xml', 'coverage/u.out', null, 'reports/u'],
    ['dotnet', 'TestResults/u/**/*.trx', 'TestResults/u/**/coverage.cobertura.xml', null, 'TestResults/u'],
    ['dart', 'reports/u/test.json', 'coverage/u/lcov.info', null, 'reports/u'],
    ['flutter', 'reports/u/test.json', 'coverage/lcov.info', null, 'reports/u'],
  ] as const)('%s', (lang, t, c, con, dir) => {
    expect(defaultGlobs(lang, 'u')).toEqual({ tests: [t], coverage: [c], consoleLog: con, testsDir: dir });
  });
  test('generic has no defaults', () => {
    expect(defaultGlobs('generic', 'u')).toMatchObject({ tests: [], coverage: [], consoleLog: null });
  });
});

describe('collect: Bun', () => {
  const repo = () => {
    const r = tmpRepo({ 'src/m.ts': 'export const a = 1;\n', 'tests/m.test.ts': 'x\n' });
    write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
    write(r, 'reports/unit/console.log', fixture('bun/console.log'));
    write(r, 'coverage/unit/lcov.info', fixture('bun/lcov.info'));
    return r;
  };
  test('finds files by default globs, attaches console failure text, normalizes paths', () => {
    const r = repo();
    const c = collect(inputs({ language: 'bun' }), r);
    expect(c.files.map(f => f.kind).sort()).toEqual(['console', 'junit', 'lcov']);
    const fails = c.cases!.filter(x => x.status === 'failed');
    expect(fails.map(x => x.name)).toEqual(['fails', 'throws']);
    expect(fails[0]!.message).toBe('expect(received).toBe(expected)\n\nExpected: 4\nReceived: 3');
    expect(fails[0]!.stack).toContain('m.test.ts:7:22');
    expect(fails[1]!.message).toBe('boom');
    expect([...c.coverage!.files.keys()]).toEqual(['src/m.ts']);
    expect(c.warnings).toEqual([]);
    expect(c.hasTestFile && c.hasCoverageFile).toBe(true);
  });
  test('explicit globs override the defaults; unrelated files are ignored', () => {
    const r = repo();
    write(r, 'out/other.xml', fixture('bun/junit.xml'));
    const c = collect(inputs({ language: 'bun', tests: ['out/*.xml'], coverage: ['nothing/*.info'] }), r);
    expect(c.files.map(f => f.rel)).toEqual(['out/other.xml', 'reports/unit/console.log']);
    expect(c.coverage).toBeNull();
    expect(c.hasCoverageFile).toBe(false);
  });
  test('several test files of one kind are concatenated', () => {
    const r = repo();
    write(r, 'reports/unit/b.xml', fixture('bun/junit.xml').replace(/math/g, 'other'));
    const c = collect(inputs({ language: 'bun', tests: ['reports/unit/*.xml'] }), r);
    expect(c.cases!.length).toBe(8);
  });
  test('a missing console log is silent by default but warned about when requested', () => {
    const r = tmpRepo();
    write(r, 'reports/unit/junit.xml', fixture('bun/junit.xml'));
    expect(collect(inputs({ language: 'bun' }), r).problems).toEqual([]);
    expect(collect(inputs({ language: 'bun', consoleLog: 'nope.log' }), r).problems.join()).toMatch(/console-log not found/);
  });
  test('no files at all → null cases/coverage and no crash', () => {
    const c = collect(inputs(), tmpRepo());
    expect(c).toMatchObject({ cases: null, coverage: null, hasTestFile: false, hasCoverageFile: false });
  });
  test('unrecognized and broken files are skipped with a problem, not thrown', () => {
    const r = tmpRepo();
    write(r, 'reports/unit/junit.xml', 'this is not xml');
    const c = collect(inputs({ language: 'bun' }), r);
    expect(c.cases).toBeNull();
    expect(c.problems.join()).toMatch(/unrecognized report format/);
    write(r, 'reports/unit/junit.xml', '<testsuites><testsuite name="a"><testcase name="x"');
    expect(() => collect(inputs({ language: 'bun' }), r)).not.toThrow();
  });
  test('working-directory scopes the globs, and paths stay repo-root-relative', () => {
    const r = tmpRepo({ 'web/src/m.ts': 'x\n' });
    write(r, 'web/reports/unit/junit.xml', fixture('bun/junit.xml'));
    write(r, 'web/coverage/unit/lcov.info', fixture('bun/lcov.info'));
    const c = collect(inputs({ language: 'bun', workingDirectory: 'web' }), r);
    expect([...c.coverage!.files.keys()]).toEqual(['web/src/m.ts']);
  });
  test('markers GATE_FAILED / INACTIVE are read from the tests dir', () => {
    const r = tmpRepo();
    write(r, 'reports/unit/GATE_FAILED', '');
    expect(collect(inputs({ language: 'bun' }), r)).toMatchObject({ gateMarker: true, inactiveMarker: false });
    const r2 = tmpRepo();
    write(r2, 'TestResults/unit/INACTIVE', '');
    expect(collect(inputs({ language: 'dotnet' }), r2)).toMatchObject({ inactiveMarker: true, gateMarker: false });
  });
});

describe('collect: Go', () => {
  const repo = (cover: string) => {
    const r = tmpRepo({ 'go.mod': 'module example.com/spike\n\ngo 1.26\n', 'calc/calc.go': 'package calc\n', 'calc/calc_test.go': 'package calc\n', 'other/o.go': 'package other\n' });
    write(r, 'reports/unit/junit.xml', fixture('go/junit.xml'));
    write(r, 'coverage/unit.out', cover);
    return r;
  };
  test('import paths map to repo paths via go.mod; failing test files resolve against the package dir', () => {
    const c = collect(inputs({ language: 'go' }), repo(fixture('go/nopanic.out')));
    expect([...c.coverage!.files.keys()].sort()).toEqual(['calc/calc.go']);
    const sub = c.cases!.find(x => x.name === 'TestSub')!;
    expect(sub.file).toBe('calc/calc_test.go');
    expect(sub.line).toBe(10);
    expect(sub.suite).toBe('calc');
    expect(c.warnings).toEqual([]);
  });
  test('a panic marks the coverage partial', () => {
    const c = collect(inputs({ language: 'go' }), repo(fixture('go/mixed.out')));
    expect(c.coverage!.partial).toBe(true);
    expect(c.notes.join()).toMatch(/panicked \(go\)/);
  });
  test('the empty profile a panic leaves behind is partial too, with no files', () => {
    const c = collect(inputs({ language: 'go' }), repo(fixture('go/unit.out')));
    expect(c.coverage!.files.size).toBe(0);
    expect(c.coverage!.partial).toBe(true);
  });
  test('without a panic the coverage is not partial', () => {
    const r = tmpRepo({ 'go.mod': 'module example.com/spike\n', 'calc/calc.go': 'x\n' });
    write(r, 'reports/unit/junit.xml', '<testsuites><testsuite name="p"><testcase classname="example.com/spike/calc" name="TestA"><failure message="Failed">calc_test.go:3: no</failure></testcase></testsuite></testsuites>');
    write(r, 'coverage/unit.out', fixture('go/nopanic.out'));
    expect(collect(inputs({ language: 'go' }), r).coverage!.partial).toBe(false);
  });
  test('Go ids use the import path (CONTRACT §3: package + "." + TestName), the suite shows the repo dir', () => {
    const a = collect(inputs({ language: 'go' }), repo(fixture('go/nopanic.out'))).cases!.find(x => x.name === 'TestAdd')!;
    expect(a.id).toBe(makeId('unit', 'example.com/spike/calc.TestAdd'));
    expect(a.suite).toBe('calc');
  });
});

describe('collect: .NET', () => {
  test('failing TRX + Cobertura with <sources>/', () => {
    const r = tmpRepo({ 'Tests/UnitTest1.cs': 'x\n', 'Lib/Class1.cs': 'x\n' });
    write(r, 'TestResults/unit/abc/run.trx', fixture('dotnet/unit-failing.trx'));
    write(r, 'TestResults/unit/abc/coverage.cobertura.xml', fixture('dotnet/collector-failing.cobertura.xml'));
    const c = collect(inputs({ language: 'dotnet' }), r);
    expect(c.cases!.map(x => x.status).sort()).toEqual(['errored', 'failed', 'passed', 'skipped']);
    const f = c.cases!.find(x => x.name === 'Fails')!;
    expect(f.file).toBe('Tests/UnitTest1.cs');
    expect(f.line).toBe(4);
    expect([...c.coverage!.files.keys()]).toEqual(['Lib/Class1.cs']);
    expect(c.coverage!.format).toBe('cobertura');
  });
  test('several TRX files (one per project) are merged', () => {
    const r = tmpRepo();
    write(r, 'TestResults/unit/a/a.trx', fixture('dotnet/unit-failing.trx'));
    write(r, 'TestResults/unit/b/b.trx', fixture('dotnet/unit-failing.trx'));
    const c = collect(inputs({ language: 'dotnet' }), r);
    expect(c.cases!.length).toBe(8);
    expect(new Set(c.cases!.map(x => x.id)).size).toBe(8);
  });
});

describe('collect: Dart / Flutter', () => {
  test('dart: failure vs error, absolute LCOV paths → repo-relative', () => {
    const r = tmpRepo({ 'lib/src/m.dart': 'x\n', 'test/m_test.dart': 'x\n' });
    write(r, 'reports/unit/test.json', fixture('dart/dart.json'));
    write(r, 'coverage/unit/lcov.info', fixture('dart/lcov.info'));
    const c = collect(inputs({ language: 'dart' }), r);
    expect(c.cases!.find(x => x.name === 'math fails')!.status).toBe('failed');
    expect(c.cases!.find(x => x.name === 'math throws')!.status).toBe('errored');
    expect([...c.coverage!.files.keys()]).toEqual(['lib/src/m.dart']);
    expect(c.cases!.find(x => x.name === 'math fails')!.file).toBe('test/m_test.dart');
  });
  test('flutter uses coverage/lcov.info', () => {
    const r = tmpRepo({ 'lib/src/m.dart': 'x\n' });
    write(r, 'reports/unit/test.json', fixture('dart/dart.json'));
    write(r, 'coverage/lcov.info', fixture('dart/lcov.info'));
    expect(collect(inputs({ language: 'flutter' }), r).coverage!.files.size).toBe(1);
  });
});

describe('collect: generic JUnit', () => {
  test('needs the tests input', () => {
    const c = collect(inputs({ language: 'generic' }), tmpRepo());
    expect(c.problems.join()).toMatch(/needs the "tests" input/);
  });
  test('reads any JUnit given by glob, any extension', () => {
    const r = tmpRepo();
    write(r, 'out/results.txt', '<testsuite name="s"><testcase classname="a" name="b"/></testsuite>');
    const c = collect(inputs({ language: 'generic', tests: ['out/results.txt'] }), r);
    expect(c.cases!.length).toBe(1);
  });
});

describe('paths not tracked by git', () => {
  test('are kept and warned about', () => {
    const r = tmpRepo({ 'src/a.ts': 'x\n' });
    write(r, 'coverage/unit/lcov.info', 'SF:/nix/store/' + 'a'.repeat(32) + '-x/generated.ts\nDA:1,1\nend_of_record\n');
    const c = collect(inputs({ language: 'bun' }), r);
    expect(c.warnings.join()).toMatch(/coverage path not tracked by git/);
    expect(c.coverage!.files.size).toBe(1);
  });
});
