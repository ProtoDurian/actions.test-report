import { Client, HttpError } from './http';
import { readRaw, refit, type Built } from './build';
import { blobContent } from './git';
import { gzip, errMsg } from './util';

export const UPLOAD_BUDGET_MS = 4 * 60_000;
export const SOURCE_CONCURRENCY = 6;

export interface UploadResult {
  runId: number | null;
  url: string | null;
  /** problems that did not stop the upload (finish was accepted) */
  problems: string[];
  /** false → finish itself failed; caller falls back to the artifact */
  finished: boolean;
}

/** GET known-failing → which of those ids pass in this run (CONTRACT §2.2). */
export async function fetchRecovered(client: Client, flag: string, built: Built, problems: string[]): Promise<string[]> {
  if (!built.summary.tests) return [];
  try {
    const res = await client.request<{ ids?: string[] }>('GET', `/api/v1/runs/known-failing?flag=${encodeURIComponent(flag)}`);
    const known = new Set(res.ids ?? []);
    const passed = new Set<string>();
    for (const c of built.report?.tests?.cases ?? []) if (c.status === 'passed') passed.add(c.id);
    return [...known].filter(id => passed.has(id));
  } catch (e) {
    problems.push(`known-failing: ${errMsg(e)}`);
    return [];
  }
}

export async function startRun(client: Client, body: unknown): Promise<void> {
  await client.request('POST', '/api/v1/runs/start', { json: body });
}

/**
 * CONTRACT §2: known-failing → finish → report → cov/n → raw/<name> → sources/check → sources/<blob>.
 * Only `finish` is fatal. Everything after it is best effort; a rate limit (429 after retries) stops the optional uploads.
 */
export async function uploadAll(client: Client, flag: string, built: Built, rootDir: string, budgetMs: number = UPLOAD_BUDGET_MS): Promise<UploadResult> {
  const problems: string[] = [];
  const now = client.deps.now ?? Date.now;
  const startedAt = now();
  const recovered = await fetchRecovered(client, flag, built, problems);
  if (built.summary.tests) built.summary.tests.recovered = recovered;
  refit(built);

  let fin: { runId?: number; url?: string; missingReport?: boolean };
  try {
    fin = await client.request('POST', '/api/v1/runs/finish', { json: built.summary });
  } catch (e) {
    return { runId: null, url: null, problems: [...problems, `finish: ${errMsg(e)}`], finished: false };
  }
  const runId = fin.runId ?? null;
  const url = fin.url ?? null;
  if (runId === null) return { runId, url, problems: [...problems, 'finish: response had no runId'], finished: true };
  if (built.overCap) return { runId, url, problems, finished: true };

  let limited = false;
  let outOfTime = false;
  const attempt = async (what: string, fn: () => Promise<unknown>, optional = false): Promise<void> => {
    if (outOfTime || (optional && limited)) return;
    if (now() - startedAt > budgetMs) {
      if (!outOfTime) problems.push(`upload budget of ${Math.round(budgetMs / 1000)}s used up; the remaining uploads (starting with ${what}) were skipped`);
      outOfTime = true;
      return;
    }
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${errMsg(e)}`);
      if (e instanceof HttpError && e.status === 429) limited = true;
    }
  };

  const base = `/api/v1/runs/${runId}`;
  const scope = `?flag=${encodeURIComponent(flag)}&job=${encodeURIComponent(built.summary.context.job)}`;
  if (built.report) await attempt('report', () => client.request('PUT', `${base}/report`, { gzip: gzip(JSON.stringify(built.report)) }));
  for (let n = 0; n < built.chunks.length; n++) {
    await attempt(`cov/${n}`, () => client.request('PUT', `${base}/cov/${n}`, { gzip: gzip(JSON.stringify(built.chunks[n])) }));
  }
  for (const r of built.raw) {
    await attempt(`raw/${r.name}`, () => client.request('PUT', `${base}/raw/${encodeURIComponent(r.name)}`, { gzip: readRaw(r) }), true);
  }
  if (built.blobs.size) {
    let missing: string[] = [];
    await attempt(
      'sources/check',
      async () => {
        const res = await client.request<{ missing?: string[] }>('POST', `/api/v1/sources/check${scope}`, { json: { blobs: [...built.blobs.keys()] } });
        missing = (res.missing ?? []).filter(b => built.blobs.has(b));
      },
      true,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < missing.length) {
        const blob = missing[next++]!;
        await attempt(
          `sources/${blob.slice(0, 8)}`,
          () => client.request('PUT', `/api/v1/sources/${blob}${scope}`, { gzip: gzip(blobContent(rootDir, blob)) }),
          true,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(SOURCE_CONCURRENCY, missing.length) }, worker));
  }
  return { runId, url, problems, finished: true };
}
