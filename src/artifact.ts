import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Built } from './build';

export type ArtifactUploader = (name: string, files: string[], root: string) => Promise<void>;

export const artifactName = (flag: string): string => `test-report-${flag.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const uniqueArtifactName = (flag: string, job: string, runAttempt: number): string =>
  `${artifactName(flag)}-${job.replace(/[^A-Za-z0-9._-]/g, '_')}-${runAttempt}`;

const isConflict = (e: unknown): boolean => /\b409\b|already exists|conflict/i.test(e instanceof Error ? e.message : String(e));

export async function realUploader(name: string, files: string[], root: string): Promise<void> {
  const { DefaultArtifactClient } = await import('@actions/artifact');
  await new DefaultArtifactClient().uploadArtifact(name, files, root, { retentionDays: 14 });
}

/** Fork PRs / no OIDC / server down: keep the report as a workflow artifact `test-report-<flag>`. */
export async function uploadArtifactFallback(
  flag: string,
  built: Built,
  runnerTemp: string,
  upload: ArtifactUploader = realUploader,
): Promise<string> {
  const name = artifactName(flag);
  const dir = join(runnerTemp, `diene-artifact-${name}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(built.summary));
  files.push(summaryPath);
  if (built.report) {
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(built.report));
    files.push(reportPath);
  }
  try {
    await upload(name, files, dir);
    return name;
  } catch (e) {
    // matrix jobs sharing a flag in one run all want test-report-<flag>; the second one gets a 409
    if (!isConflict(e)) throw e;
    const alt = uniqueArtifactName(flag, built.summary.context.job, built.summary.context.runAttempt);
    await upload(alt, files, dir);
    return alt;
  }
}
