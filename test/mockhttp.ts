import { gunzipSync } from 'node:zlib';
import { Client, type HttpDeps } from '../src/http';

export interface Call {
  method: string;
  path: string;
  token: string;
  contentType: string | undefined;
  json?: any;
  gz?: Buffer;
}

export type Handler = (c: Call, attempt: number) => { status: number; body?: unknown } | undefined;

/** Fake fetch + getIDToken. Tokens are numbered so tests can prove a fresh one is used per call. */
export function mock(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const tokens: string[] = [];
  const sleeps: number[] = [];
  const attempts = new Map<string, number>();
  let n = 0;
  const deps: HttpDeps = {
    getIDToken: async aud => {
      expect_aud(aud);
      const t = `tok-${++n}`;
      tokens.push(t);
      return t;
    },
    sleep: async ms => {
      sleeps.push(ms);
    },
    backoffMs: [1000, 3000, 9000],
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method,
        path: u.pathname + u.search,
        token: (init.headers.authorization ?? '').replace('Bearer ', ''),
        contentType: init.headers['content-type'],
      };
      if (typeof init.body === 'string') call.json = JSON.parse(init.body);
      else if (init.body) {
        call.gz = Buffer.from(init.body);
        const raw = gunzipSync(call.gz);
        try {
          call.json = JSON.parse(raw.toString('utf8'));
        } catch {
          call.json = raw;
        }
      }
      const key = `${call.method} ${call.path}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      calls.push(call);
      const r = handler(call, attempt) ?? defaults(call);
      return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
    },
  };
  return { client: new Client('https://reports.atomi.cloud', deps), calls, tokens, sleeps, deps };
}

function expect_aud(aud: string): void {
  if (aud !== 'diene-reports') throw new Error(`wrong audience ${aud}`);
}

function defaults(c: Call): { status: number; body?: unknown } {
  if (c.path === '/api/v1/runs/start') return { status: 200, body: { runId: 123, state: 'started' } };
  if (c.path.startsWith('/api/v1/runs/known-failing')) return { status: 200, body: { ids: [] } };
  if (c.path === '/api/v1/runs/finish')
    return { status: 200, body: { runId: 123, url: 'https://reports.atomi.cloud/o/r/commit/abc', missingReport: true } };
  if (c.path.startsWith('/api/v1/sources/check')) return { status: 200, body: { missing: c.json.blobs } };
  return { status: 200, body: {} };
}
