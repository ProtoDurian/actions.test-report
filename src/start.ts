import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GhEnv } from './env';
import { stateFilePath } from './env';
import { Client } from './http';
import type { Inputs } from './types';
import { errMsg } from './util';
import { startRun } from './upload';

export interface StartResult {
  statePath: string;
  posted: boolean;
  problems: string[];
}

/** mode: start — remember when the job began, then tell the server so a lost job can be detected. */
export async function runStart(inputs: Inputs, env: GhEnv, client: Client | null, now: Date = new Date()): Promise<StartResult> {
  const problems: string[] = [];
  const timeoutMinutes = inputs.timeoutMinutes ?? 30;
  const statePath = stateFilePath(env.runnerTemp, inputs.flag);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ startedAt: now.toISOString(), timeoutMinutes }));
  } catch (e) {
    problems.push(`cannot write state file ${statePath}: ${errMsg(e)}`);
  }
  let posted = false;
  if (client) {
    try {
      await startRun(client, {
        schema: 'diene-start/v1',
        flag: inputs.flag,
        job: env.job,
        language: inputs.language,
        workflow: env.workflow,
        timeoutMinutes,
        headSha: env.headSha,
        pr: env.pr,
        baseRef: env.baseRef,
        baseSha: env.baseSha,
      });
      posted = true;
    } catch (e) {
      problems.push(`start was not reported to the server: ${errMsg(e)}`);
    }
  } else {
    problems.push('no OIDC token available (fork PR, or the job lacks `id-token: write`); start was not reported');
  }
  return { statePath, posted, problems };
}
