# diene-reports ⇄ actions.test-report — wire contract (v1, FROZEN 2026-10-30)

This file is the single source of truth between the **Worker** (`ProtoDurian/diene-reports`) and the
**action** (`ProtoDurian/actions.test-report`). An identical copy lives in both repos. Change it in both, in the
same change, or not at all. Background and reasons: `DESIGN.md` in this folder (copied from
`diene/feasibility/test-reports/DESIGN.md`). Where this file and DESIGN.md disagree, **this file wins**.

## 0. Fixed decisions (owner, 2026-10-30)

| Item | Value |
|---|---|
| Hostname | `https://reports.atomi.dev` (Worker custom domain). Also reachable at `https://diene-reports.kirinnee.workers.dev` |
| Plan | Workers Paid (already on the account) |
| Viewer access | Cloudflare Access on the whole host, reusing the account's existing reusable policy `primordial-ernestOnly`. Bypass for `/api/v1/*` and `/badge/*` |
| Rollout | shadow next to Codecov for 1 week, then remove Codecov |
| Action home | `ProtoDurian/actions.test-report`, pinned `@v1` (moving major tag) |
| OIDC audience | `diene-reports` |
| Allowed `repository_owner_id` | `349664883` (ProtoDurian), `55664364` (AtomiCloud) — Worker env `ALLOWED_OWNER_IDS="349664883,55664364"` |
| Fork / Dependabot without OIDC | job summary + artifact `test-report-<flag>` only; nothing uploaded |

## 1. Auth (every `/api/v1/*` call)

`Authorization: Bearer <JWT>` where the JWT is from `core.getIDToken('diene-reports')`. The action fetches a
**fresh token per HTTP call** (tokens are short-lived; never cache across calls).

Worker checks, else `401 {"error":"<reason>"}`:
RS256 signature against `https://token.actions.githubusercontent.com/.well-known/jwks` (cache 1 h, re-fetch once on
unknown `kid`); `iss == https://token.actions.githubusercontent.com`; `aud == diene-reports`; `exp`/`nbf`/`iat` with
60 s skew; `repository_owner_id ∈ ALLOWED_OWNER_IDS` (else `403`).

**Identity comes from the token only:** `repository`, `repository_id`, `repository_owner`, `repository_owner_id`,
`repository_visibility`, `sha`, `ref`, `event_name`, `run_id`, `run_attempt`, `actor`, `job_workflow_ref`,
`workflow`. If the body carries `sha`, `runId` or `runAttempt` and they differ from the token → `400`.

**Where results land** (derived from token `ref` + `event_name`):

| ref | lane | project branch | pr |
|---|---|---|---|
| `refs/heads/<b>` | `branch` | `<b>` | null |
| `refs/pull/<n>/merge` | `pr` | body `baseRef` (the PR's base branch; required for lane `pr`) | `<n>` |
| `refs/tags/<t>` | `tag` | `tag:<t>` | null |
| anything else | `other` | `ref:<ref>` | null |

Only lane `branch` updates branch history (`branch_head`, `test_stats`, `keep/`). A PR never writes branch history.

Rate limit: max 60 `/api/v1` writes per (`repository_id`, `run_id`, `run_attempt`); over → `429`.

## 2. Endpoints

All JSON bodies are UTF-8 `application/json`. All `PUT` binary bodies are **gzip** bytes
(`Content-Type: application/gzip`), stored to R2 as-is (the Worker never decompresses them, except `/sources`, §2.7).
Every response is JSON. Every write is **idempotent** (a retry with the same identity overwrites, never duplicates).

Run identity key = (`repository_id`, `run_id`, `run_attempt`, `flag`, `job`) — `job` is `$GITHUB_JOB`.

### 2.1 `POST /api/v1/runs/start`

```jsonc
{ "schema": "diene-start/v1",
  "flag": "unit", "job": "unit", "language": "bun", "workflow": "CI",
  "timeoutMinutes": 30,
  "headSha": "…|null", "pr": 12, "baseRef": "main|null", "baseSha": "…|null" }
```
→ `200 { "runId": 123, "state": "started" }`. Creates the run with `state=started`,
`deadline_at = now + timeoutMinutes + 15 min`. If the run already finished, leaves it alone and returns its state.

### 2.2 `GET /api/v1/runs/known-failing?flag=<flag>`

→ `200 { "ids": ["<testId>", …] }` — test ids in `test_stats` with `last_status='failed'` for this token's project
(lane `branch` only; other lanes get `[]`), max 5000. The action reports which of them now **pass** in
`tests.recovered` so flips are counted without sending the passing list.

### 2.3 `POST /api/v1/runs/finish`

Body = a `diene-summary/v1` document (§3), max **2 MB**. → `200`:
```jsonc
{ "runId": 123, "url": "https://reports.atomi.dev/<owner>/<repo>/commit/<sha>",
  "missingReport": true }
```
Creates the run if `start` never arrived (orphan; `started_at = null`). A `finish` after the run was marked `lost`
replaces `lost`. Writes the D1 summary rows; it does **not** need the report blobs to exist yet.

### 2.4 `PUT /api/v1/runs/:runId/report`

gzip of the full `diene-report/v1` document (§4). Max 20 MB. Stored at
`rep/<repo_id>/<sha>/<flag>/<run_id>-<attempt>.json.gz`; sets `runs.report_key`. The run must belong to the
token's `repository_id` + `run_id` + `run_attempt` (else `403`).

### 2.5 `PUT /api/v1/runs/:runId/cov/:n`

`n` = 0-based chunk index (as listed in the summary's `coverage.files[].chunk`). Body = gzip of
```jsonc
{ "schema": "diene-cov/v1",
  "files": { "src/lib/m.ts": { "lines": [[1,33],[2,0]], "branches": [[2,1,2]] /* [line, hit, total] or null */ } } }
```
Chunk = at most 200 files and ~1 MB uncompressed. Stored at `cov/<repo_id>/<sha>/<flag>/<run_id>-<attempt>/<n>.json.gz`.

### 2.6 `PUT /api/v1/runs/:runId/raw/:name`

Raw tool output, gzip. `name` matches `^[A-Za-z0-9._-]{1,100}$` and appears in the summary's `raw[]`. Max 20 MB.
Stored at `raw/<repo_id>/<sha>/<run_id>-<attempt>/<flag>/<name>.gz`.

### 2.7 Sources

`POST /api/v1/sources/check` body `{ "blobs": ["<git blob sha1>", …] }` (max 20 000) →
`200 { "missing": [ … ] }`. Re-stamps `blobs.last_ref_at = now` for **every** listed blob it has.

`PUT /api/v1/sources/:blobSha` body = gzip of the raw file bytes (max 1 MB uncompressed; larger files are not
sent — the viewer links to GitHub). The Worker gunzips, recomputes `sha1("blob " + len + "\0" + bytes)`, rejects a
mismatch with `400`, stores at `src/<repo_id>/<blob_sha>` (gzip). `204` if it already exists.

### 2.8 Errors

`400` bad body · `401` bad token · `403` wrong owner / wrong run · `404` unknown run · `413` too big · `429` rate
limit · `5xx` server. The action retries `429`/`5xx`/network errors 3× with backoff (1 s, 3 s, 9 s), never others.

## 3. `diene-summary/v1` (the `finish` body)

```jsonc
{
  "schema": "diene-summary/v1",
  "context": {
    "sha": "…", "runId": 1, "runAttempt": 1,          // echo of GitHub env, cross-checked against the token
    "headSha": "…|null",                                // pull_request: event.pull_request.head.sha; else = sha
    "pr": 12, "baseRef": "main|null", "baseSha": "…|null",
    "workflow": "CI", "job": "unit", "flag": "unit",
    "language": "bun|go|dotnet|dart|flutter|generic", "tool": "bun 1.3.13|null",
    "timeoutMinutes": 30
  },
  "outcome": {
    "testStep": "success|failure|cancelled|skipped|null",
    "jobStatus": "success|failure|cancelled|null",
    "class": "passed|tests_failed|errored|cancelled|timed_out|no_report|inactive",
    "subReason": "gate|setup|crash|null",               // only when class = errored
    "jobFailedAfterTests": false,                       // class passed but jobStatus != success
    "startedAt": "ISO|null", "finishedAt": "ISO",
    "notes": ["coverage partial: a test binary panicked (go)"]
  },
  "tests": null | {
    "totals": { "total": 4, "passed": 1, "failed": 1, "errored": 1, "skipped": 1, "durationMs": 25 },
    "failures": [                                        // failed + errored only, max 200, failed first
      { "id": "<testId>", "suite": "math", "name": "fails", "file": "tests/m.test.ts|null", "line": 5,
        "status": "failed|errored", "durationMs": 0,
        "message": "≤ 4 KB", "stack": "≤ 16 KB|null" } ],
    "failuresTruncated": false,
    "recovered": ["<testId>"]                            // from §2.2: known-failing ids that passed this run
  },
  "coverage": null | {
    "format": "lcov|cobertura|go",
    "totals": { "lines": 120, "linesHit": 110, "branches": null, "branchesHit": null },
    "partial": false,
    "files": [ { "path": "src/lib/m.ts", "lines": 10, "hit": 9, "chunk": 0 } ]   // max 20 000
  },
  "patch": null | {                                      // pull_request runs only
    "lines": 12, "hit": 10,                              // changed lines that are coverable / hit
    "files": [ { "path": "src/lib/m.ts", "lines": 3, "hit": 2, "uncovered": [7] } ]
  },
  "sources": [ { "path": "src/lib/m.ts", "blob": "<git blob sha1>", "bytes": 812 } ],
  "raw": [ { "name": "junit.xml", "kind": "junit|trx|dart-json|lcov|cobertura|goprofile|console", "bytes": 1234 } ],
  "warnings": ["coverage path not tracked by git: /nix/store/…"],
  "overCap": false                                       // true → report/cov were not uploaded; page says so
}
```

**Test id** = first 20 hex chars of `sha1(flag + "|" + nativeIdentity)`. Never includes file/line.
nativeIdentity: Go `package + "." + TestName` (subtests keep `/sub`); TRX `testName` (fully qualified);
JUnit `classname + "::" + name` (Bun: nested describe path joined with ` > `); Dart `suitePath + "::" + fullName`.

## 4. `diene-report/v1` (the full report, `PUT …/report`)

Exactly DESIGN.md §2.1. Notes: `tests.cases[]` holds **all** cases (passed too); `coverage.files[].lines` is
`[[line, hits], …]`; `diff.files` is `{ path: [changed line numbers] }`. The viewer reads it only for the full
test list; everything else reads D1 or `cov/` chunks.

## 5. Outcome classification (action side; DESIGN §3.2)

Inputs: `test-outcome` (`steps.<id>.outcome`), `job-status` (`job.status`), parsed report, marker files under the
test dir (`GATE_FAILED`, `INACTIVE`), console log, elapsed since `start` (from a state file the `start` step wrote
to `$RUNNER_TEMP/diene-report-<flag>.json`; if absent: `startedAt = null`).

1. `jobStatus == cancelled` → `timed_out` if elapsed ≥ `timeoutMinutes − 3 min`, else `cancelled`.
2. `INACTIVE` marker present and no tests → `inactive`.
3. testStep `success`: no test file and no coverage file → `no_report`; else `passed`
   (`jobFailedAfterTests = jobStatus != success`).
4. testStep `failure`: ≥ 1 failed/errored test → `tests_failed`; else `errored` with subReason `gate` if a
   `GATE_FAILED` marker exists or the console log has a line starting with `❌` that mentions `coverage`, else `crash`.
5. testStep `skipped` → `errored:setup`. testStep `cancelled` → rule 1 logic using elapsed.
6. testStep empty/unknown → classify from the report alone (`tests_failed` if failures, else `passed` if any
   report, else `no_report`), and add a note.

Worker-only states: `started` (start, no finish yet) and `lost` (cron: `state=started AND now > deadline_at`).

## 6. Default file globs per `language` (relative to `working-directory`)

| language | tests | coverage | console |
|---|---|---|---|
| bun | `reports/<flag>/junit.xml` | `coverage/<flag>/lcov.info` | `reports/<flag>/console.log` |
| go | `reports/<flag>/junit.xml` | `coverage/<flag>.out` | — |
| dotnet | `TestResults/<flag>/**/*.trx` | `TestResults/<flag>/**/coverage.cobertura.xml` | — |
| dart | `reports/<flag>/test.json` | `coverage/<flag>/lcov.info` | — |
| flutter | `reports/<flag>/test.json` | `coverage/lcov.info` | — |
| generic | (input required) | (optional) | — |

Format is detected from content, not the extension (`<testsuites`/`<testsuite` → JUnit, `<TestRun` → TRX,
first JSON line `{"protocolVersion"` or `"type":"start"` → Dart JSON, `SF:` → LCOV, `<coverage` → Cobertura,
`mode: ` → Go coverprofile). Markers: `<tests dir>/GATE_FAILED`, `<tests dir>/INACTIVE` where tests dir =
`reports/<flag>/` (dotnet: `TestResults/<flag>/`).
