import { describe, expect, test } from 'bun:test';
import { detectFormat } from '../src/detect';
import { parseBunConsole } from '../src/parsers/bunconsole';
import { parseCobertura } from '../src/parsers/cobertura';
import { parseDartJson } from '../src/parsers/dart';
import { parseGoCover } from '../src/parsers/gocover';
import { parseJunit } from '../src/parsers/junit';
import { parseLcov } from '../src/parsers/lcov';
import { parseTrx } from '../src/parsers/trx';
import { parseXml } from '../src/parsers/xml';
import { fixture } from './helpers';

const byName = <T extends { name: string }>(l: T[], n: string): T => l.find(c => c.name === n)!;

describe('xml', () => {
  test('decodes numeric and named entities', () => {
    const d = parseXml('<a m="x&#xA;y&#9;z&amp;&lt;">t&#xA;u &quot;q&quot; &#x1F600;</a>');
    expect(d.a['@_m']).toBe('x\ny\tz&<');
    expect(d.a['#text']).toBe('t\nu "q" 😀');
  });
  test('strips a BOM', () => {
    expect(parseXml('﻿<a/>')).toHaveProperty('a');
  });
});

describe('detectFormat (by content, not extension)', () => {
  test.each([
    ['<?xml version="1.0"?>\n<testsuites name="x">', 'junit'],
    ['<testsuite name="x">', 'junit'],
    ['﻿<?xml version="1.0"?>\n<TestRun id="1">', 'trx'],
    ['<?xml version="1.0"?><coverage line-rate="1">', 'cobertura'],
    ['{"protocolVersion":"0.1.1","type":"start"}\n', 'dart-json'],
    ['{"type":"start","time":0}\n', 'dart-json'],
    ['TN:\nSF:src/a.ts\n', 'lcov'],
    ['SF:src/a.ts\n', 'lcov'],
    ['mode: atomic\nx.go:1.1,2.2 1 1\n', 'goprofile'],
    ['hello world', null],
    ['', null],
    ['<html><body/></html>', null],
  ] as const)('%j -> %s', (head, kind) => {
    expect(detectFormat(head)).toBe(kind);
  });
  test('real fixtures', () => {
    expect(detectFormat(fixture('bun/junit.xml'))).toBe('junit');
    expect(detectFormat(fixture('go/junit.xml'))).toBe('junit');
    expect(detectFormat(fixture('dotnet/unit-failing.trx'))).toBe('trx');
    expect(detectFormat(fixture('dotnet/collector-failing.cobertura.xml'))).toBe('cobertura');
    expect(detectFormat(fixture('dart/dart.json'))).toBe('dart-json');
    expect(detectFormat(fixture('dart/lcov.info'))).toBe('lcov');
    expect(detectFormat(fixture('bun/lcov.info'))).toBe('lcov');
    expect(detectFormat(fixture('go/mixed.out'))).toBe('goprofile');
  });
});

describe('JUnit: Bun (nested suites)', () => {
  const { cases } = parseJunit(fixture('bun/junit.xml'), { language: 'bun' });
  test('walks the nested describe and skips the file-level suite', () => {
    expect(cases.map(c => c.name)).toEqual(['adds', 'fails', 'skipped', 'throws']);
    expect(cases.every(c => c.suite === 'math')).toBe(true);
    expect(cases[0]!.identity).toBe('math::adds');
    expect(cases[0]!.consoleKey).toBe('math > adds');
  });
  test('statuses, file and line', () => {
    expect(byName(cases, 'adds').status).toBe('passed');
    expect(byName(cases, 'fails').status).toBe('failed');
    expect(byName(cases, 'skipped').status).toBe('skipped');
    expect(byName(cases, 'fails')).toMatchObject({ file: 'tests/m.test.ts', line: 5 });
  });
  test('nested describes are joined with " > "', () => {
    const xml = `<testsuites><testsuite name="a.test.ts" file="a.test.ts"><testsuite name="outer" file="a.test.ts" line="1">
      <testsuite name="inner" file="a.test.ts" line="2"><testcase name="t" classname="inner" file="a.test.ts" line="3"/></testsuite>
    </testsuite></testsuite></testsuites>`;
    const [c] = parseJunit(xml, { language: 'bun' }).cases;
    expect(c!.suite).toBe('outer > inner');
    expect(c!.identity).toBe('outer > inner::t');
    expect(c!.consoleKey).toBe('outer > inner > t');
  });
});

describe('JUnit: Go (gotestsum)', () => {
  const { cases } = parseJunit(fixture('go/junit.xml'), { language: 'go' });
  test('identity is package + test name', () => {
    expect(byName(cases, 'TestSub').identity).toBe('example.com/spike/calc.TestSub');
    expect(byName(cases, 'TestAdd').status).toBe('passed');
    expect(byName(cases, 'TestSkip').status).toBe('skipped');
  });
  test('file:line is extracted from the failure text and the noise is cleaned', () => {
    const sub = byName(cases, 'TestSub');
    expect(sub).toMatchObject({ file: 'calc_test.go', line: 10, fileBase: 'example.com/spike/calc' });
    expect(sub.message).toBe('calc_test.go:10: Sub(5,2) = 3, want 4');
  });
  test('a panic keeps its message and goroutine stack', () => {
    const p = byName(cases, 'TestPanic');
    expect(p.message).toStartWith('panic: assignment to entry in nil map');
    expect(p.stack).toContain('goroutine 9 [running]');
    expect(p.line).toBe(12);
    expect(p.file).toEndWith('calc_test.go');
  });
  test('passing tests carry no file', () => {
    expect(byName(cases, 'TestAdd').file).toBeNull();
  });
  test('subtests keep their /sub name', () => {
    const xml = `<testsuites><testsuite name="p/q"><testcase classname="p/q" name="TestA/sub_1" time="0.1"/></testsuite></testsuites>`;
    expect(parseJunit(xml, { language: 'go' }).cases[0]!.identity).toBe('p/q.TestA/sub_1');
  });
});

describe('JUnit: generic', () => {
  test('identity is classname::name; failure vs error', () => {
    const xml = `<testsuite name="s"><testcase classname="a.B" name="x" time="1.5"><failure message="bad">trace</failure></testcase>
      <testcase classname="a.B" name="y"><error message="oops" type="E"/></testcase>
      <testcase classname="a.B" name="z"><skipped/></testcase></testsuite>`;
    const { cases } = parseJunit(xml, { language: 'generic' });
    expect(cases.map(c => [c.identity, c.status])).toEqual([
      ['a.B::x', 'failed'],
      ['a.B::y', 'errored'],
      ['a.B::z', 'skipped'],
    ]);
    expect(cases[0]!.message).toBe('bad\ntrace');
    expect(cases[0]!.durationMs).toBe(1500);
    expect(cases[1]!.message).toBe('E: oops');
  });
});

describe('TRX (.NET)', () => {
  const { cases } = parseTrx(fixture('dotnet/unit-failing.trx'));
  test('statuses: Failed with an assertion is failed, a thrown exception is errored, NotExecuted is skipped', () => {
    expect(byName(cases, 'Fails').status).toBe('failed');
    expect(byName(cases, 'Throws').status).toBe('errored');
    expect(byName(cases, 'Skipped').status).toBe('skipped');
    expect(byName(cases, 'Adds').status).toBe('passed');
  });
  test('identity is the fully-qualified test name', () => {
    expect(byName(cases, 'Fails').identity).toBe('Tests.UnitTest1.Fails');
    expect(byName(cases, 'Fails').suite).toBe('Tests.UnitTest1');
  });
  test('message, stack, file and line come from ErrorInfo', () => {
    const f = byName(cases, 'Fails');
    expect(f.message).toBe('Assert.Equal() Failure: Values differ\nExpected: 4\nActual:   3');
    expect(f.stack).toContain('at Tests.UnitTest1.Fails()');
    expect(f).toMatchObject({ file: '/tmp/scratch/spike-dotnet/Tests/UnitTest1.cs', line: 4 });
    expect(byName(cases, 'Throws')).toMatchObject({ line: 6, message: 'System.InvalidOperationException : boom' });
  });
  test('duration is parsed from hh:mm:ss.fffffff', () => {
    expect(byName(cases, 'Fails').durationMs).toBe(2);
  });
});

describe('Dart / Flutter JSON reporter', () => {
  const { cases, warnings } = parseDartJson(fixture('dart/dart.json'));
  test('hidden "loading" tests are skipped; four real cases', () => {
    expect(cases.map(c => c.name)).toEqual(['math adds', 'math fails', 'math skipped', 'math throws']);
    expect(warnings).toEqual([]);
  });
  test('failure (isFailure) vs error (thrown)', () => {
    expect(byName(cases, 'math fails').status).toBe('failed');
    expect(byName(cases, 'math throws').status).toBe('errored');
    expect(byName(cases, 'math skipped').status).toBe('skipped');
  });
  test('identity is suitePath::fullName; message and stack kept', () => {
    const f = byName(cases, 'math fails');
    expect(f.identity).toBe('test/m_test.dart::math fails');
    expect(f.message).toBe('Expected: <4>\n  Actual: <3>');
    expect(f.stack).toContain('test/m_test.dart 6:25');
    expect(f).toMatchObject({ line: 6, file: 'test/m_test.dart' });
  });
  test('warns when the run never finished (no done event)', () => {
    const cut = fixture('dart/dart.json').split('\n').filter(l => !l.includes('"type":"done"')).join('\n');
    expect(parseDartJson(cut).warnings.join(' ')).toMatch(/done/);
  });
});

describe('Bun console failure text', () => {
  const m = parseBunConsole(fixture('bun/console.log'));
  test('collects the block before each (fail) line, keyed by describe > name', () => {
    expect([...m.keys()]).toEqual(['math > fails', 'math > throws']);
    const f = m.get('math > fails')![0]!;
    expect(f.message).toBe('expect(received).toBe(expected)\n\nExpected: 4\nReceived: 3');
    expect(f.stack).toContain('tests/m.test.ts:7:22');
    expect(m.get('math > throws')![0]!.message).toBe('boom');
  });
  test('passing tests do not leak into the next failure', () => {
    const t = ['error: first', '(pass) a > ok', 'error: second', '(fail) a > bad'].join('\n');
    expect(parseBunConsole(t).get('a > bad')![0]!.message).toBe('second');
  });
  test('ANSI colors and timings are ignored', () => {
    const t = '\u001b[31merror\u001b[0m: red\n(fail) a > b [1.20ms]';
    expect(parseBunConsole(t).get('a > b')![0]!.message).toBe('red');
  });
});

describe('LCOV', () => {
  test('line hits', () => {
    const p = parseLcov(fixture('bun/lcov.info'));
    expect(p.format).toBe('lcov');
    expect([...p.files.get('src/m.ts')!.lines]).toEqual([[1, 33], [2, 55]]);
  });
  test('absolute SF paths are kept as written (normalized later)', () => {
    const p = parseLcov(fixture('dart/lcov.info'));
    expect([...p.files.keys()]).toEqual(['/tmp/scratch/spike-dart/lib/src/m.dart']);
  });
  test('BRDA becomes per-line [taken,total]; "-" is not taken', () => {
    const p = parseLcov('SF:a.ts\nDA:1,1\nBRDA:1,0,0,1\nBRDA:1,0,1,-\nBRDA:1,1,0,3\nend_of_record\n');
    expect(p.files.get('a.ts')!.branches.get(1)).toEqual([2, 3]);
  });
});

describe('Cobertura', () => {
  const p = parseCobertura(fixture('dotnet/collector-failing.cobertura.xml'));
  test('reads <sources> and class-level lines', () => {
    expect(p.sources).toEqual(['/']);
    const entries = [...p.files];
    expect(entries.length).toBe(1);
    expect(entries[0]![0]).toEndWith("spike-dotnet/Lib/Class1.cs");
    expect([...entries[0]![1].lines]).toEqual([[2, 3]]);
  });
  test('uses the max per line when methods repeat a line, and condition-coverage for branches', () => {
    const xml = `<coverage><sources><source>/r</source></sources><packages><package><classes>
      <class filename="a.cs"><methods><method name="m"><lines><line number="1" hits="1" branch="False"/></lines></method></methods>
      <lines><line number="1" hits="2" branch="False"/><line number="2" hits="1" branch="True" condition-coverage="50% (1/2)"/></lines></class>
      </classes></package></packages></coverage>`;
    const q = parseCobertura(xml);
    const fc = q.files.get('a.cs')!;
    expect(fc.lines.get(1)).toBe(2);
    expect(fc.branches.get(2)).toEqual([1, 2]);
    expect(q.sources).toEqual(['/r']);
  });
});

describe('Go coverprofile', () => {
  test('block ranges expand to lines, max count wins', () => {
    const p = parseGoCover(fixture('go/mixed.out'));
    const calc = p.files.get('example.com/spike/calc/calc.go')!;
    expect(calc.lines.get(3)).toBe(1);
    expect(calc.lines.get(7)).toBe(0);
    expect(calc.lines.get(6)).toBe(1);
    expect(p.files.get('example.com/spike/other/o.go')!.lines.get(3)).toBe(0);
  });
  test('a profile with only the mode line has no files and warns', () => {
    const p = parseGoCover(fixture('go/unit.out'));
    expect(p.files.size).toBe(0);
    expect(p.warnings.join(' ')).toMatch(/no blocks/);
  });
});
