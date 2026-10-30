import * as core from '@actions/core';
import type { Inputs, Language } from './types';

export const DEFAULT_ENDPOINT = 'https://reports.atomi.cloud';
const LANGS: Language[] = ['bun', 'go', 'dotnet', 'dart', 'flutter', 'generic'];

export const splitList = (v: string): string[] =>
  v
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

export function readInputs(): Inputs {
  const mode = core.getInput('mode').trim();
  if (mode !== 'start' && mode !== 'finish') throw new Error(`input "mode" must be "start" or "finish" (got "${mode}")`);
  const flag = core.getInput('flag').trim();
  if (!flag) throw new Error('input "flag" is required');
  const langIn = core.getInput('language').trim().toLowerCase();
  const language = (LANGS as string[]).includes(langIn) ? (langIn as Language) : 'generic';
  const tm = Number(core.getInput('timeout-minutes') || '30');
  return {
    mode,
    flag,
    language,
    tests: splitList(core.getInput('tests')),
    coverage: splitList(core.getInput('coverage')),
    consoleLog: core.getInput('console-log').trim(),
    workingDirectory: core.getInput('working-directory').trim(),
    testOutcome: core.getInput('test-outcome').trim(),
    jobStatus: core.getInput('job-status').trim(),
    timeoutMinutes: Number.isFinite(tm) && tm > 0 ? tm : 30,
    endpoint: (core.getInput('endpoint').trim() || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
  };
}
