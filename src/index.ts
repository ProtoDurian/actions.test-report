import * as core from '@actions/core';
import { readGhEnv } from './env';
import { runFinish } from './finish';
import { Client } from './http';
import { readInputs } from './inputs';
import { runStart } from './start';
import { errMsg } from './util';

async function main(): Promise<void> {
  const inputs = readInputs();
  const env = readGhEnv();
  const client = env.oidcAvailable ? new Client(inputs.endpoint) : null;
  if (inputs.mode === 'start') {
    const r = await runStart(inputs, env, client);
    for (const p of r.problems) core.warning(p);
    return;
  }
  const r = await runFinish(inputs, env, { client, warn: m => core.warning(m) });
  core.setOutput('class', r.class);
  core.setOutput('run-url', r.url ?? '');
  core.info(`diene report (${inputs.flag}): ${r.class}${r.url ? ` ${r.url}` : ''} [upload: ${r.uploaded}]`);
}

// This action must never fail the job it reports on.
main().then(
  () => process.exit(0),
  e => {
    core.warning(`test-report: ${errMsg(e)}`);
    process.exit(0);
  },
);
