import * as core from '@actions/core';
import { errMsg, sleep } from './util';

export const AUDIENCE = 'diene-reports';
export const BACKOFF_MS = [1000, 3000, 9000];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}${body ? ` ${body.slice(0, 200)}` : ''}`);
  }
}

export interface HttpDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{ status: number; text(): Promise<string> }>;
  getIDToken: (audience: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  backoffMs: number[];
}

export const realDeps = (): HttpDeps => ({
  fetch: (url, init) => fetch(url, init as RequestInit),
  getIDToken: aud => core.getIDToken(aud),
  sleep,
  backoffMs: BACKOFF_MS,
});

export type Body = { json: unknown } | { gzip: Uint8Array } | undefined;

const retryable = (status: number): boolean => status === 429 || status >= 500;

export class Client {
  constructor(
    readonly endpoint: string,
    readonly deps: HttpDeps = realDeps(),
  ) {}

  /** One call: fresh OIDC token per attempt; 429/5xx/network errors retried 3x (1s, 3s, 9s); 4xx never. */
  async request<T = any>(method: string, path: string, body?: Body): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.deps.backoffMs.length; attempt++) {
      if (attempt > 0) await this.deps.sleep(this.deps.backoffMs[attempt - 1]!);
      try {
        const token = await this.deps.getIDToken(AUDIENCE);
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
        let payload: string | Uint8Array | undefined;
        if (body && 'json' in body) {
          headers['content-type'] = 'application/json';
          payload = JSON.stringify(body.json);
        } else if (body && 'gzip' in body) {
          headers['content-type'] = 'application/gzip';
          payload = body.gzip;
        }
        const res = await this.deps.fetch(this.endpoint + path, { method, headers, body: payload });
        const text = await res.text().catch(() => '');
        if (res.status >= 200 && res.status < 300) {
          if (!text) return {} as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            return {} as T;
          }
        }
        const err = new HttpError(res.status, method, path, text);
        if (!retryable(res.status)) throw err;
        last = err;
      } catch (e) {
        if (e instanceof HttpError && !retryable(e.status)) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(errMsg(last));
  }
}
