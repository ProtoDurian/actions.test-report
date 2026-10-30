import * as core from '@actions/core';
import type { Inputs, Language } from './types';

export const DEFAULT_ENDPOINT = 'https://reports.atomi.cloud';
const LANGS: Language[] = ['bun', 'go', 'dotnet', 'dart', 'flutter', 'generic'];

export const splitList = (v: string): string[] =>
  v
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

/** The OIDC token goes to this host, so plain http is only allowed for local testing. */
export function assertSecureEndpoint(endpoint: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error(`input "endpoint" is not a valid URL: ${endpoint}`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('input "endpoint" must be https (http is only allowed for localhost)');
}

export function readInputs(): Inputs {
  const mode = core.getInput('mode').trim();
  if (mode !== 'start' && mode !== 'finish') throw new Error(`input "mode" must be "start" or "finish" (got "${mode}")`);
  const flag = core.getInput('flag').trim();
  if (!flag) throw new Error('input "flag" is required');
  const langIn = core.getInput('language').trim().toLowerCase();
  const language = (LANGS as string[]).includes(langIn) ? (langIn as Language) : 'generic';
  const tmRaw = core.getInput('timeout-minutes').trim();
  const tm = tmRaw === '' ? NaN : Number(tmRaw);
  const endpoint = (core.getInput('endpoint').trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  assertSecureEndpoint(endpoint);
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
    timeoutMinutes: Number.isFinite(tm) && tm > 0 ? tm : null,
    endpoint,
  };
}
