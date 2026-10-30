import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GhEnv } from '../src/env';
import type { Inputs } from '../src/types';

export const FIXTURES = join(import.meta.dir, '..', 'fixtures');
export const fixture = (p: string): string => readFileSync(join(FIXTURES, p), 'utf8');

export function write(root: string, rel: string, content: string | Buffer): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/** A real git repo in a temp dir; `files` are committed. Returns its (symlink-resolved) root. */
export function tmpRepo(files: Record<string, string> = {}): string {
  const root = execFileSync('realpath', [mkdtempSync(join(tmpdir(), 'tr-'))], { encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) write(root, p, c);
  commitAll(root, 'init');
  return root;
}

export function commitAll(root: string, msg: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', msg);
}

export { git };

export function inputs(over: Partial<Inputs> = {}): Inputs {
  return {
    mode: 'finish',
    flag: 'unit',
    language: 'bun',
    tests: [],
    coverage: [],
    consoleLog: '',
    workingDirectory: '',
    testOutcome: '',
    jobStatus: '',
    timeoutMinutes: 30,
    endpoint: 'https://reports.atomi.cloud',
    ...over,
  };
}

export function ghEnv(over: Partial<GhEnv> = {}): GhEnv {
  return {
    repository: 'ProtoDurian/x',
    repositoryId: 42,
    visibility: 'public',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    refName: 'main',
    eventName: 'push',
    runId: 7,
    runAttempt: 1,
    workflow: 'CI',
    job: 'unit',
    serverUrl: 'https://github.com',
    pr: null,
    headSha: 'a'.repeat(40),
    baseRef: null,
    baseSha: null,
    workspace: '',
    runnerTemp: tmpdir(),
    stepSummary: null,
    oidcAvailable: true,
    ...over,
  };
}
