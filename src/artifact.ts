import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Built } from './build';

export type ArtifactUploader = (name: string, files: string[], root: string) => Promise<void>;

export const artifactName = (flag: string): string => `test-report-${flag.replace(/[^A-Za-z0-9._-]/g, '_')}`;

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
  await upload(name, files, dir);
  return name;
}
