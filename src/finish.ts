import { appendFileSync, readFileSync } from 'node:fs';
import { artifactName, realUploader, uploadArtifactFallback, type ArtifactUploader } from './artifact';
import { build } from './build';
import { classify, hasGateLine } from './classify';
import { collect } from './collect';
import { parseDiff } from './diff';
import type { GhEnv } from './env';
import { stateFilePath } from './env';
import { diffMergeParent } from './git';
import { Client } from './http';
import { renderSummary } from './render';
import { detectTool } from './tool';
import type { Inputs, OutcomeClass, SummaryDoc } from './types';
import { errMsg } from './util';
import { uploadAll } from './upload';

export interface FinishDeps {
  client: Client | null;
  uploader?: ArtifactUploader;
  now?: () => Date;
  tool?: (language: Inputs['language']) => string | null;
  cwd?: string;
  warn?: (m: string) => void;
}

export interface FinishResult {
  class: OutcomeClass;
  url: string | null;
  uploaded: 'yes' | 'no' | 'artifact';
  summary: SummaryDoc;
  markdown: string;
}

export function readStartedAt(path: string): string | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.startedAt;
    return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

export async function runFinish(inputs: Inputs, env: GhEnv, deps: FinishDeps): Promise<FinishResult> {
  const warn = deps.warn ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const c = collect(inputs, deps.cwd);
  for (const p of c.problems) warn(p);

  const failedOrErrored = (c.cases ?? []).filter(x => x.status === 'failed' || x.status === 'errored').length;
  const cl = classify({
    testOutcome: inputs.testOutcome || null,
    jobStatus: inputs.jobStatus || null,
    hasTestFile: c.hasTestFile,
    hasCoverageFile: c.hasCoverageFile,
    failedOrErrored,
    totalTests: c.cases?.length ?? 0,
    gateMarker: c.gateMarker,
    inactiveMarker: c.inactiveMarker,
    consoleGateLine: c.consoleText ? hasGateLine(c.consoleText) : false,
    startedAt: readStartedAt(stateFilePath(env.runnerTemp, inputs.flag)),
    finishedAt: now.toISOString(),
    timeoutMinutes: inputs.timeoutMinutes,
  });
  const outcome = {
    testStep: inputs.testOutcome || null,
    jobStatus: inputs.jobStatus || null,
    class: cl.class,
    subReason: cl.subReason,
    jobFailedAfterTests: cl.jobFailedAfterTests,
    startedAt: readStartedAt(stateFilePath(env.runnerTemp, inputs.flag)),
    finishedAt: now.toISOString(),
    notes: [...c.notes, ...cl.notes],
  };

  let diff: Map<string, number[]> | null = null;
  if (env.pr !== null && c.coverage) {
    const text = diffMergeParent(c.root);
    if (text !== null) diff = parseDiff(text);
    else warn('could not run `git diff HEAD^1 HEAD` (shallow checkout?); patch coverage skipped');
  }

  const built = build({
    inputs,
    env,
    collected: c,
    outcome,
    tool: (deps.tool ?? detectTool)(inputs.language),
    diff,
    warnings: c.warnings,
  });

  let uploaded: FinishResult['uploaded'] = 'no';
  let url: string | null = null;
  let artifact: string | null = null;
  const problems: string[] = [];

  if (deps.client) {
    try {
      const r = await uploadAll(deps.client, inputs.flag, built, c.root);
      for (const p of r.problems) {
        problems.push(p);
        warn(p);
      }
      if (r.finished) {
        uploaded = 'yes';
        url = r.url;
      }
    } catch (e) {
      problems.push(`upload: ${errMsg(e)}`);
      warn(`upload: ${errMsg(e)}`);
    }
  } else {
    const m = 'no OIDC token available (fork PR, or the job lacks `id-token: write`); the report is kept as an artifact';
    problems.push(m);
    warn(m);
  }

  if (uploaded !== 'yes') {
    try {
      artifact = await uploadArtifactFallback(inputs.flag, built, env.runnerTemp, deps.uploader ?? realUploader);
      uploaded = 'artifact';
    } catch (e) {
      problems.push(`artifact upload failed: ${errMsg(e)}`);
      warn(`artifact upload failed: ${errMsg(e)}`);
    }
  }

  const markdown = renderSummary({
    summary: built.summary,
    url,
    uploaded,
    artifactName: artifact ?? artifactName(inputs.flag),
    problems,
  });
  if (env.stepSummary) {
    try {
      appendFileSync(env.stepSummary, markdown + '\n');
    } catch (e) {
      warn(`cannot write the step summary: ${errMsg(e)}`);
    }
  }
  return { class: cl.class, url, uploaded, summary: built.summary, markdown };
}
