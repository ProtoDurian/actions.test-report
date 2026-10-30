import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GhEnv {
  repository: string;
  repositoryId: number | null;
  visibility: string | null;
  sha: string;
  ref: string;
  refName: string;
  eventName: string;
  runId: number;
  runAttempt: number;
  workflow: string;
  job: string;
  serverUrl: string;
  pr: number | null;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  workspace: string;
  runnerTemp: string;
  stepSummary: string | null;
  oidcAvailable: boolean;
}

const int = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

export function readGhEnv(e: NodeJS.ProcessEnv = process.env): GhEnv {
  let event: any = {};
  try {
    if (e.GITHUB_EVENT_PATH) event = JSON.parse(readFileSync(e.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    event = {};
  }
  const sha = e.GITHUB_SHA ?? '';
  const ref = e.GITHUB_REF ?? '';
  const pull = event.pull_request;
  const prFromRef = /^refs\/pull\/(\d+)\//.exec(ref);
  const isPr = !!pull || !!prFromRef;
  const pr = isPr ? (int(String(pull?.number ?? event.number ?? '')) ?? (prFromRef ? Number(prFromRef[1]) : null)) : null;
  const repo = event.repository;
  const visibility: string | null = repo?.visibility ?? (typeof repo?.private === 'boolean' ? (repo.private ? 'private' : 'public') : null);
  return {
    repository: e.GITHUB_REPOSITORY ?? '',
    repositoryId: int(e.GITHUB_REPOSITORY_ID) ?? int(String(repo?.id ?? '')),
    visibility,
    sha,
    ref,
    refName: e.GITHUB_REF_NAME ?? ref.replace(/^refs\/(heads|tags)\//, ''),
    eventName: e.GITHUB_EVENT_NAME ?? '',
    runId: int(e.GITHUB_RUN_ID) ?? 0,
    runAttempt: int(e.GITHUB_RUN_ATTEMPT) ?? 1,
    workflow: e.GITHUB_WORKFLOW ?? '',
    job: e.GITHUB_JOB ?? '',
    serverUrl: e.GITHUB_SERVER_URL ?? 'https://github.com',
    pr,
    headSha: isPr ? (pull?.head?.sha ?? null) : sha || null,
    baseRef: isPr ? (pull?.base?.ref ?? e.GITHUB_BASE_REF ?? null) || null : null,
    baseSha: isPr ? (pull?.base?.sha ?? null) : null,
    workspace: e.GITHUB_WORKSPACE ?? '',
    runnerTemp: e.RUNNER_TEMP || tmpdir(),
    stepSummary: e.GITHUB_STEP_SUMMARY || null,
    oidcAvailable: !!e.ACTIONS_ID_TOKEN_REQUEST_URL && !!e.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
}

export const stateFilePath = (runnerTemp: string, flag: string): string =>
  join(runnerTemp, `diene-report-${flag.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
