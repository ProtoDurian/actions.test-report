# diene test reports — a self-hosted Codecov replacement on Cloudflare (DESIGN, 2026-10-29)

Status: **design only — nothing built, no repo created, nothing deployed.** Build phases: [`PLAN.md`](PLAN.md).
Evidence from scratch spikes: [`spikes/`](spikes). Working name: **`diene-reports`**.

Owner ask (verbatim): "For codecov, can we build a full Cloudflare app with access to everything? Just make this a
dummy Cloudflare or personal thing so that we can replace the codecov? please make sure yiou have a good plan on how it
works on CI, and it should straight up support all the languages we use. it should be a test report viewer + test
coverage viewer. it should account for: failed tests, failed test run, and still report test and coverage results"

## 0. The answer in 12 lines

1. **Yes, it is feasible**, and smaller than it sounds: one Cloudflare Worker (API + HTML viewer), one D1 database,
   one R2 bucket, one GitHub JavaScript action. No GitHub App and no long-lived secret are needed for v1.
2. **Parsing happens on the CI runner, not in the Worker.** The action reads each tool's native output, turns it
   into one normalized JSON report, and uploads it. The Worker only checks auth, stores, and indexes. This keeps
   Worker CPU tiny (the Free plan allows 10 ms per request) and keeps all language knowledge in one place.
3. **Native formats are enough — almost no new tools.** Bun → JUnit XML + LCOV. Go → gotestsum JUnit XML + Go
   coverprofile. .NET → TRX (already written today) + Cobertura (switch coverlet MSBuild → coverlet collector,
   because MSBuild writes **no coverage when a test fails** — proven in a spike). Dart/Flutter → the
   `package:test` JSON reporter + LCOV. Helm charts have no test suite today; generic JUnit is accepted if one is
   added later.
4. **The action runs twice per test job:** `start` before the tests and `finish` with `if: always()` after them.
   The pair is how "the run crashed" is told apart from "tests failed": a `start` with no `finish` is a lost run.
5. **Every run gets one of 7 outcomes:** passed · tests failed · run errored (crash/compile/gate, no test failures
   recorded) · cancelled · timed out · lost (runner died, no `finish`) · no report (step passed but wrote nothing).
   Results and coverage are **still stored** in every case where files exist.
6. **Auth = GitHub Actions OIDC.** The Worker verifies GitHub's signed token and allows only
   `repository_owner_id` in an allow-list (ProtoDurian; AtomiCloud optional). `CODECOV_TOKEN` goes away.
7. **Fork PRs:** no OIDC token exists there, so v1 writes the report to the job summary and an artifact only.
   diene has no outside contributors today; a `workflow_run` relay is a later, optional phase.
8. **Rollout = ratchet patches at 8 origins** (bun-base, bun-lib, dotnet-base, dotnet-lib, go-base, go-lib,
   dart-lib, flutter-base) covering today's 66 Codecov steps, plus `id-token: write` on the 164 calling jobs,
   per-node test-script merges, the Codecov **probes** (62 branches) and `codecov.yml` files (66) replaced, and a
   .NET package switch on 17 nodes (§6). The action lives in its own repo **`AtomiCloud/actions.test-report`**,
   pinned `@v1` like `actions.setup-nix` — the house lint only allows tag pins for `^AtomiCloud/` — so a parser
   fix is one tag move, never a cascade.
9. **Viewer:** server-rendered, plain, mobile-friendly HTML. Per **project** (= repo + branch, because each
   diene.all node branch is its own project) / commit / PR: failures with message,
   stack and `file:line`; failed-run banner; new-failure and flaky marks against the base; coverage totals, file
   list, line view; patch (diff) coverage on PRs; SVG badges to replace the Codecov README badges.
10. **Access:** whole viewer behind Cloudflare Access (free up to 50 users, GitHub login). Ingest and badge paths
    bypass Access (OIDC protects ingest; badges show numbers only).
11. **Cost:** **Workers Paid ($5/month) recommended.** Free can work only with care (10 ms CPU, 50 D1 queries per
    request, 10 ms cron); Paid removes all three. R2 stays at or just over its free 10 GB with 30-day raw and
    90-day report retention (cents per month if over).
12. **Must be proven by spikes before the build** (§9): OIDC on Namespace runners, `always()` on job timeout,
    Dependabot OIDC, Flutter's JSON file reporter, the .NET coverlet-collector switch on a real multi-project
    node. Already proven here: Bun JUnit lacks failure text, a Go panic drops the panicking test binary's
    coverage (for every package it covers), coverlet MSBuild drops all coverage on failure (6.0.4 and 10.1.0).

Independent Opus review: [`REVIEW.md`](REVIEW.md) — SOUND-WITH-FIXES, 0 blockers; all 8 major and 10 minor findings
are folded into this version (marked `[R:M1]` etc. where they changed the text). Re-check: [`RECHECK.md`](RECHECK.md) — 16 fixed, 2 partial, 1 new major + 8 minor/nit; all of those are folded in too (`[R:N1]`–`[R:N9]`).

## 1. What exists today (verified)

| Fact | Evidence |
|---|---|
| 66 Codecov upload steps, exactly one workflow file per branch | `spikes/codecov-callsites.txt` (from `git grep codecov/codecov-action` over the 66 branches that hold `CODECOV_TOKEN`) |
| 4 origin families own them | bun-base `⚡reusable-test.yaml` (22 branches incl. nextjs-frontend, 11 `lib/bun/*`), dotnet-base `⚡reusable-test.yaml` (17), go-base (18: 10 use `reusable-go-test.yaml` + `codecov-action@v5`, 8 use `⚡reusable-go-test.yaml` + a SHA pin — two filenames for the same thing), dart-lib `⚡reusable-test.yaml` (9: dart-lib + 8 `lib/dart/*`) |
| 164 test jobs call those workflows | 34 branches × 2 tiers + 32 × 3 tiers (`unit`, `int`, `meta`) in each branch's `ci.yaml` |
| Calling jobs grant only `contents: read` | e.g. `go-base` and `bun-lib` `ci.yaml` |
| No test job sets `timeout-minutes` | so a hung job runs for GitHub's 6-hour default |
| Codecov steps are `fail_ci_if_error: false` / `continue-on-error` | a missed upload is silent today |
| **Today failed runs often upload nothing** | dotnet (`dotnet-lib` + 11 `lib/dotnet/*`): the `has-results` output is set only after `test.sh` succeeds, so on failure the TRX/coverage uploads are skipped; and coverlet MSBuild writes no coverage on a red run anyway (§2). go: the Codecov step has no `always()` (18/18), so it is skipped on failure. bun: plain `always()`; dart: `always()` + `hashFiles`, so they do upload. |
| The meta tier is added lower down | `meta` jobs come from `bun-lib` and `dotnet-lib` fragments (12 branches each), not from the bases [R:M1] |
| Codecov is also asserted by probes and config | Codecov probes on 62/66 branches (`bun-codecov-config`, `codecov-config`, `dotnet-codecov-config`, `codecov-configuration`, plus `dotnet-multi-project-coverage`), `codecov.yml`/`.codecov.yaml` on 66/66, Codecov badges in 36/66 READMEs [R:M2] |
| Test scripts are not uniform | 12 distinct bun `test.sh` blobs over 22 branches, 9 dart over 9, 5 go `local/test.sh`, 3 `dotnet-test.sh` [R:M1] |
| Flutter (`flutter-base`) runs `flutter test` with no coverage and no report | `flutter-base:scripts/ci/test.sh` |
| Helm charts / helm-wrapper have no unit-test tool | no `helm unittest`; they run lint/kubeconform/kyverno gates |
| Shared actions live in their own public repos | `AtomiCloud/actions.setup-nix`, `actions.cache-*`, `actions.setup-docker` |
| `workspace` holds no test workflow | its workflows: cd, ci, release, docker, helm, named-checks, precommit, release, merge-gatekeeper |
| Org | ProtoDurian, GitHub Free; 57 public + 7 private repos. All 66 Codecov users are public repos or `diene.all` (public). |
| Runners | Namespace, Developer plan: bun `nscloud-ubuntu-26.04-amd64-16x32-with-cache`; go/dotnet/dart/flutter `nscloud-ubuntu-22.04-amd64-4x8-with-cache` |
| Action pin rule | `workspace:dlint.yaml` `action-pins.trustedPattern: ^AtomiCloud/` — trusted actions use a major tag (`@v3`), everything else an exact SHA [R:M4] |
| Test jobs are short | 0–2 min in sampled runs, so `timeout-minutes: 30` is safe |

**Correction to the brief:** the brief says the shared step should sit on the `workspace` template. `workspace` has no
test workflow, and its children do not share one test workflow either: each language base owns its own, and some
tiers are added further down. So the *call sites* land at 8 origins (§6). The action itself sits in its own repo,
which is what makes it "one" thing. `workspace` gets only the docs/standard page (optional).

## 2. Ingest — per language (verified in spikes unless marked)

Spike setup: a tiny project per language with 1 passing, 1 failing (assertion), 1 skipped and 1 throwing test, run
in `/tmp` with nix-provided tools. Output files are kept in `spikes/<lang>/`.

| Language | Tests: command | Tests: format | Coverage: command | Coverage: format | Spike |
|---|---|---|---|---|---|
| **Bun / TS / Next.js** | `bun test --config=bunfig.<mode>.toml --coverage --reporter=junit --reporter-outfile=reports/<mode>/junit.xml` (or `[test.reporter] junit = "…"` in bunfig) | JUnit XML | already `coverageReporter = ["text","lcov"]` | LCOV `coverage/<mode>/lcov.info` | ✅ Bun 1.3.13 |
| **Go** | add `--junitfile reports/<mode>/junit.xml --junitfile-testcase-classname=relative` to the existing `gotestsum` call (repo-relative package paths) | JUnit XML | existing `-coverprofile=coverage/<mode>.out` | Go coverprofile (parsed natively; no converter) | ✅ go 1.26.8, gotestsum |
| **.NET** | already `--logger "trx;LogFileName=<mode>-<project>.trx"` | TRX (parsed natively; no extra logger package) | **change:** coverlet **collector** `--collect "XPlat Code Coverage"` (format cobertura), one file per project, merged by the test script [R:N3]. Today's coverlet **MSBuild** writes nothing when a test fails (spike) | Cobertura `TestResults/<mode>/**/coverage.cobertura.xml` | ✅ SDK 8.0.425, xunit 2.5.3, coverlet.msbuild 10.1.0 (reviewer re-ran with the repo's 6.0.4: same), coverlet.collector 6.0.0 |
| **Dart** | add `--file-reporter=json:reports/<mode>/dart-test.json` to `dart test` (runs inside the pub-workspace member, e.g. `packages/diene_dart_lib`, so the action takes a `working-directory` input) [R:m8] | `package:test` JSON events | existing `dart test --coverage` + `coverage:format_coverage --lcov` | LCOV | ✅ Dart SDK (nixpkgs), test 1.33 |
| **Flutter** | `flutter test --coverage --file-reporter=json:reports/unit/flutter-test.json` | same JSON events | `--coverage` → `coverage/lcov.info` | LCOV | ⚠️ not run (SDK too big for a scratch spike) — spike S5 |
| **Playwright (nextjs e2e)** | `playwright test --reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_FILE` | JUnit XML | — | — | doc only; later phase |
| **Helm charts** | none today; if added: `helm unittest -t JUnit -o reports/helm/junit.xml <chart>` | JUnit XML | — | — | n/a |

Spike findings that shape the design:

- **Bun's JUnit has file + line but no failure text.** Bun 1.3.13 writes `<failure type="AssertionError" />` with no
  message or stack, even for a thrown `Error("boom")` (`spikes/bun/junit.xml`). Tests are nested
  `<testsuite>` per `describe`, so the parser must walk nested suites. Bun also **does not create the output
  directory** (`ENOENT`); the script must `mkdir -p` first. Open upstream PRs (#44434, #44435) report that load and
  syntax errors are dropped from the JUnit file entirely (the reviewer reproduced it). Bun prints failures to
  **stderr**, message and stack *before* the `(fail) suite > name` line. → The script runs
  `bun test … 2>&1 | tee reports/<mode>/console.log` (pipefail keeps the exit code) and the action attaches the
  block that ends at each `(fail)` line as that test's message [R:n3].
- **Bun LCOV is line-only.** An untaken `if` branch still shows 100 % lines (`spikes/bun/lcov.info`). No branch data.
- **Go: a panic loses the panicking test binary's coverage.** With a panicking test, `-coverprofile` held only
  `mode: atomic` (`spikes/go/unit.out`). Plain assertion failures keep full coverage (`nopanic.out`). The repo runs
  `-coverpkg=<all packages>`, so the lost binary's hits on **every** package it exercised vanish, and which files
  are affected cannot be told [R:m3]. → the run is marked **coverage partial**; patch coverage is shown as
  "unreliable" and the delta vs base is skipped.
- **Go JUnit has no file/line attributes;** the location is inside the failure text (`calc_test.go:10: …`). The
  parser extracts it; with `--junitfile-testcase-classname=relative` the classname is already the package dir [R:n4].
- **Go coverprofile paths are import paths** (`example.com/spike/calc/calc.go`). The parser strips the module
  prefix from `go.mod` to get repo-relative paths.
- **Dart's JSON reporter is the best source of all:** message, stack, line/column, and it tells an assertion
  failure (`isFailure: true`, result `failure`) from a thrown error (`result: error`). Coverage is still written
  when tests fail. LCOV `SF:` paths are **absolute** → stripped against `$GITHUB_WORKSPACE`.
- **.NET TRX already exists** and holds message + stack with `in <path>:line N` (`spikes/dotnet/unit-failing.trx`)
  — no new NuGet logger is needed. (A JUnit logger would add `JunitXml.TestLogger` to every test project.)
- **.NET coverage is lost on any failing test today.** coverlet.msbuild 10.1.0 wrote `coverage.cobertura.xml` on a
  green run and **nothing** on a red run (`spikes/dotnet/msbuild-coverlet-log.txt`). The coverlet **collector**
  (`--collect "XPlat Code Coverage"`; **not** referenced by the 17 dotnet branches today — they pin coverlet.msbuild
  6.0.4 — so the switch edits csproj/`Directory.Packages.props` and regenerates `nix/dotnet-deps.json` [R:M3]) wrote
  Cobertura on the same red run
  (`collector-failing.cobertura.xml`), one file per project under a GUID folder, with `filename` attributes that
  are absolute paths minus the leading `/`. → the dotnet family switches to the collector. Because today's
  threshold gate runs on the **merged** total across projects, the script merges the per-project files itself
  (ReportGenerator as a pinned **dotnet local tool** — `.config/dotnet-tools.json`, `dotnet-reportgenerator-globaltool`,
  locked through the existing `nix/dotnet-deps.json` mechanism; it is not in nixpkgs [R:N2] — or a small xmlstarlet
  line-sum merge) and keeps its xmlstarlet gate on that one file; the action
  uploads the merged file [R:M3].

### 2.1 One normalized model (`diene-report/v1`)

The action produces exactly one JSON document per test job, whatever the language:

```jsonc
{
  "schema": "diene-report/v1",
  "context": {            // from the OIDC token and GitHub env; the Worker re-checks against the token
    "repo": "ProtoDurian/diene.bun-lib", "repoId": 123, "visibility": "public",
    "sha": "…",            // token sha; on pull_request this is the MERGE commit
    "headSha": null,       // pull_request only: github.event.pull_request.head.sha (from the body) [R:M5]
    "ref": "refs/heads/main", "branch": "main", "event": "push",
    "pr": null, "baseSha": null, "baseRef": null,
    "runId": 1, "runAttempt": 1, "workflow": "CI", "job": "unit",
    "flag": "unit",        // tier label, same meaning as the Codecov flag today
    "language": "bun", "tool": "bun 1.3.13"
  },
  "outcome": {
    "testStep": "failure",          // steps.<id>.outcome passed in by the caller
    "jobStatus": "failure",         // job.status
    "class": "tests_failed",        // see §3.2
    "startedAt": "…", "finishedAt": "…", "timeoutMinutes": 30,
    "notes": ["coverage partial: a test binary panicked (go)"]
  },
  "tests": {
    "totals": { "total": 4, "passed": 1, "failed": 1, "errored": 1, "skipped": 1, "durationMs": 25 },
    "cases": [
      { "id": "sha1(flag|native identity)", "suite": "math", "name": "fails",
        "file": "tests/m.test.ts", "line": 5,
        "status": "failed",            // passed | failed | errored | skipped
        "durationMs": 0,
        "message": "Expected: 4\nReceived: 3",   // capped 4 KB
        "stack": "…" }                           // capped 16 KB
    ]
  },
  "coverage": {
    "format": "lcov",
    "totals": { "lines": 120, "linesHit": 110, "branches": null, "branchesHit": null },
    "partial": false,
    "files": [ { "path": "src/lib/m.ts", "lines": [[1,33],[2,55]], "branches": null } ]
  },
  "diff":    { "files": { "src/lib/m.ts": [2, 3] } },     // PR runs only: `git diff -U0 HEAD^1 HEAD` on the merge commit
  "sources": [ { "path": "src/lib/m.ts", "blob": "<git blob sha>" } ],
  "raw":     [ { "name": "junit.xml", "kind": "junit", "bytes": 1234 } ],
  "warnings": ["coverage path not tracked by git: /nix/store/…"]
}
```

Rules every parser must keep:

- Paths are repo-root-relative POSIX paths. A path that is not in `git ls-files` is kept but flagged in `warnings`.
- `status` mapping: JUnit `<failure>` → failed, `<error>` → errored, `<skipped>` → skipped; TRX `Failed` → failed
  (`errored` if no assertion type in message), `NotExecuted` → skipped; Dart `failure` → failed, `error` → errored.
- Several reports of the same kind in one job (e.g. one TRX per .NET project) are **merged**: tests are
  concatenated; coverage line hits are **summed** per file/line.
- Test `id` is stable across runs and **never includes file/line**, because Go and .NET only reveal a file for
  *failing* tests [R:M7]. id = hash(flag, native identity): Go `package + TestName`; TRX `testName` (fully qualified);
  JUnit `classname + name` (nested suite path for Bun); Dart `suite path + full test name`. It is the key for
  history, NEW and FLAKY.
- Size caps (enforced by the action, re-checked by the Worker): 20 MB per upload after gzip, 50 000 test cases,
  20 000 coverage files. Over the cap → upload the summary only and say so on the page.

## 3. CI integration

### 3.1 The action: `AtomiCloud/actions.test-report`

A **JavaScript action** (`runs.using: node24`), written in TypeScript, bundled with `bun build` into one
`dist/index.js` committed to the action repo. JavaScript actions run on the runner's own Node, so they work the same
in every repo — no Nix shell, no Bun, no jq needed.

Why a separate repo (not a file on `workspace`): a parser bug fix should be one tag move, not a cascade through ~100
branches. Call sites pin the **major tag `@v1`**, exactly like `AtomiCloud/actions.setup-nix@v3`. This needs the repo
under **AtomiCloud**: the house lint (`dlint action-pins`, `trustedPattern: ^AtomiCloud/`) forces exact-SHA pins on any
other owner, and SHA pins would turn every parser fix into a cascade (Dependabot only bumps default branches, not
the 66 diene.all node branches) [R:M4]. The other choice is widening `trustedPattern` to `^(AtomiCloud|ProtoDurian)/`
at `workspace`.

```yaml
# inputs
mode:            start | finish              # required
flag:            unit | int | meta | sit | e2e | …   # required
language:        bun | go | dotnet | dart | flutter | generic   # picks default globs
tests:           glob list; default per language (e.g. go: reports/<flag>/junit.xml)
coverage:        glob list; default per language (e.g. go: coverage/<flag>.out)
console-log:     optional path (Bun: reports/<flag>/console.log)
working-directory: optional; globs resolve under it (Dart pub-workspace member, e.g. packages/diene_dart_lib)
# head_sha is read by the action itself from GITHUB_EVENT_PATH (pull_request.head.sha); on push runs head_sha = sha [R:N7]
test-outcome:    ${{ steps.test.outcome }}   # finish only
job-status:      ${{ job.status }}           # finish only
timeout-minutes: 30                          # start only; used to call a run "lost"
endpoint:        https://reports.<domain>    # default baked into the action
comment:         false | sticky              # later phase
```

Behaviour of `finish` (never fails the job; every problem is a warning):

1. Find files by glob; parse each into the model; merge.
2. Classify the outcome (§3.2).
3. On `pull_request` runs: `git diff -U0 HEAD^1 HEAD`. The job checks out the **merge** commit, and `setup-nix`
   checks out with `fetch-depth: 0` on Linux, so this gives exactly the PR's changes in the same line numbers the
   coverage was measured on. No API call, no extra permission, no 406 on huge diffs [R:M5].
4. List `git ls-files -s` blob SHAs for every covered file (for the source view, §4.4).
5. Request a fresh OIDC token (`audience: diene-reports`), POST the report (gzip) + raw files.
6. Upload only the source blobs the Worker says it does not have yet (content-addressed, so a file stored once is
   never stored again).
7. Write a short Markdown summary + link into `$GITHUB_STEP_SUMMARY`.
8. With no OIDC (fork PR) or when the Worker is down: still do 1–2 and 7, and upload the report as an artifact
   `test-report-<flag>`. CI result never depends on the reports service.

### 3.2 Run outcome — how each case is detected

| Class | How the action/Worker decides | Tests & coverage stored? |
|---|---|---|
| `passed` | test step `success`, report found. If `job.status != success` (a later step such as go's `sit.sh` journey failed) the page says "tests passed, job failed after tests" [R:m1] | yes |
| `tests_failed` | test step `failure` and ≥1 test failed/errored in the report | yes (whatever was written) |
| `errored` | test step `failure` but **0** failed tests in the report, or no report. Sub-reasons [R:m2]: `errored:gate` (script wrote `reports/<flag>/GATE_FAILED`, or a known `❌ coverage …` line is in the console log — bun `coverageThreshold = 1.0`, bun-lib's awk gate, dotnet `/p:Threshold`, go `validate/go-coverage.sh`); `errored:setup` (test step `skipped` because nix/cache/docker failed before it) [R:m1]; `errored:crash` (everything else: compile error, Bun load error dropped from JUnit) | yes, if any files exist; page shows the sub-reason + job link |
| `cancelled` | `job.status == cancelled` and elapsed < timeout − 3 min | yes, if files exist |
| `timed_out` | `job.status == cancelled` and elapsed ≥ `timeout-minutes` − 3 min (elapsed is measured from `start`, which is the **first** step, so it is within a minute of the job clock) [R:M8]. If S2 forces a *step*-level timeout instead, the step outcome is `failure` and the action reads "timed out" from the elapsed step time | yes, if files exist |
| `lost` | `start` received, no `finish` by `started + timeout + 15 min` (Worker cron) — runner died, or the `always()` step was killed. A late `finish` replaces `lost` [R:m1] | nothing but the start record |
| `no_report` | test step `success`, no files found | no; flagged so a silently broken reporter is seen. A tier that is legitimately inactive (meta with no TestHelper) writes `reports/<flag>/INACTIVE` and is shown as "inactive", not as a problem |
| (orphan) | `finish` with no `start` (start step failed or was skipped) | stored normally; `started_at` = unknown [R:m1] |

Two small script changes make this precise:

- **`timeout-minutes: 30`** on every test job (today: 6 h default). Without it "lost" can only be declared after 6 h.
- Test scripts keep their own exit code but must leave report files behind on failure. They do: dart and bun-lib
  family capture `test_status` under `set +e`; bun-base and its template children + nextjs-frontend use plain
  `set -euo pipefail`, which is still fine because Bun writes JUnit/LCOV before it exits [R:M1];
  `dotnet-test.sh` wraps each `dotnet test` in `set +e`; gotestsum writes its JUnit file before it exits non-zero
  (spike). No exit-code logic changes; the edits are `mkdir -p`, reporter flags, `tee`, and the marker files.

### 3.3 The call site (per language origin)

```yaml
# ⚡reusable-test.yaml (bun-base shape) — after the change
    timeout-minutes: 30
    steps:
      - uses: AtomiCloud/actions.test-report@v1      # FIRST step: needs no checkout, so setup failures are seen [R:M8]
        continue-on-error: true
        with: { mode: start, flag: "${{ inputs.mode }}", language: bun, timeout-minutes: 30 }
      - uses: AtomiCloud/actions.setup-nix@v3        # does the checkout
      - uses: AtomiCloud/actions.cache-bun@v2
      - name: Run ${{ inputs.mode }} tests
        id: test
        env: { TEST_MODE: "${{ inputs.mode }}" }
        run: nix develop .#ci -c ./scripts/ci/test.sh "$TEST_MODE"
      - uses: AtomiCloud/actions.test-report@v1
        if: always()
        continue-on-error: true
        with:
          mode: finish
          flag: ${{ inputs.mode }}
          language: bun
          test-outcome: ${{ steps.test.outcome }}
          job-status: ${{ job.status }}
      # the existing actions/upload-artifact step stays (cheap second copy, 90-day GitHub retention)
```

and in every `ci.yaml` job that calls it:

```yaml
  unit:
    permissions:
      contents: read
      id-token: write      # NEW — a reusable workflow cannot raise its caller's permissions
```

`secrets: CODECOV_TOKEN` is removed from the reusable workflow's `on.workflow_call.secrets`.

### 3.4 Auth — GitHub Actions OIDC, no stored secret

- The action calls `core.getIDToken('diene-reports')`.
- The Worker verifies: RS256 signature against `https://token.actions.githubusercontent.com/.well-known/jwks`
  (cached 1 h, re-fetched on unknown `kid`), `iss`, `aud == diene-reports`, `exp`/`nbf`.
- Allow-list on **`repository_owner_id`** (numeric, survives renames; ProtoDurian's id, optionally AtomiCloud's).
  Optional deny/allow per `repository_id`.
- The Worker **takes identity from the token, never from the body**: `repository`, `repository_id`,
  `repository_visibility`, `sha`, `ref`, `event_name`, `run_id`, `run_attempt`, `actor`, `job_workflow_ref`.
  The body may only add the `flag`, `job`, and the report itself; a mismatch on `sha`/`run_id` is rejected.
- **Where results land** [R:m7]: `refs/heads/<b>` (from `push` or `workflow_dispatch`, including Dependabot's
  pushes to `dependabot/*` branches) → history of branch `<b>`. `refs/pull/<n>/merge` (`pull_request`) → only
  PR `<n>`. `refs/tags/*` (CI runs on tag pushes; `on: push` has no filter) → a tag lane, never branch history.
  `event` is stored so the UI can filter. A PR can therefore never overwrite `main`'s history.
- **PR SHAs** [R:M5]: on `pull_request` the token's `sha` is the **merge** commit. The action also sends
  `head_sha` (not verifiable from the token, informational). PR pages and the flaky "same commit" rule key on
  `head_sha`; coverage and the diff stay on the merge commit, so they always line up.
- Trust level = same as the Codecov token today: any workflow in an allowed repo can upload. That is acceptable for
  a personal tool; it is written down, not hidden.

### 3.5 Fork PRs and Dependabot — policy

| Case | OIDC? | v1 policy |
|---|---|---|
| Same-repo branch push / PR | yes | full upload |
| Fork PR (`pull_request`) | **no** (read-only token, no `id-token`) | report goes to the job summary + artifact only. Nothing stored. |
| Dependabot PR | unclear — sources disagree (spike S3) | if OIDC works: full upload; if not: like a fork |
| Later (optional): `workflow_run` relay | yes, in the base repo's trusted context | a tiny workflow in each repo downloads the `test-report-*` artifacts and uploads them as **PR-only, untrusted** data (never branch history). It never runs PR code. Only worth building if outside contributors appear. |

`pull_request_target` is **not** used anywhere (it would run fork code with a write token).

### 3.6 Namespace runners

Namespace runners are GitHub Actions runners registered with GitHub; the OIDC token is issued by GitHub's token
service (via `ACTIONS_ID_TOKEN_REQUEST_URL`), not by the runner. It should work unchanged — **spike S1 must prove it**
(one job, `id-token: write`, call `getIDToken`, decode claims). The action also runs on GitHub-hosted runners.

## 4. Backend — Cloudflare

### 4.1 Shape

```
GitHub job ──(OIDC JWT + gzip report)──▶ Worker `diene-reports`  (Hono router, TypeScript)
                                          ├─ /api/v1/runs/start      create run row (state=started)
                                          ├─ /api/v1/runs/finish     store report → R2, summary → D1
                                          ├─ /api/v1/sources         which blobs are missing / upload them
                                          ├─ /badge/…svg             public numbers for README badges
                                          ├─ HTML pages (server-rendered) + tiny JS for the line view
                                          └─ Cron */15 min           mark runs `lost`; retention clean-up
                       D1 `diene_reports`  ← summaries, failures, test history, flakiness
                       R2 `diene-reports`  ← raw files, normalized reports, source blobs
```

One Worker with static assets (Cloudflare's current recommendation over Pages for new apps). A separate Pages
project would work too; one deployable is simpler for a personal tool.

**CPU rule:** the Worker never parses big documents on ingest. The action sends a small `summary.json` (counts,
failing tests, coverage totals, per-file totals) next to the big gzip report. The Worker validates and indexes the
summary and **streams** the big report to R2 untouched. Viewer pages read the summary from D1; the line view
fetches the per-file JSON from R2 and the browser renders it. This keeps every request well under 10 ms CPU.

### 4.2 D1 schema (sketch)

```sql
repos      (repo_id INTEGER PK, owner TEXT, name TEXT, visibility TEXT, default_branch TEXT, created_at TEXT)
projects   (project_id INTEGER PK, repo_id, branch TEXT, alias_of INTEGER NULL,   -- [R:M6] project = repo + branch;
            UNIQUE (repo_id, branch))                                         -- diene.all: one per node branch;
                                                                              -- a mirror's main = alias of its node
blobs      (repo_id, blob_sha, bytes, last_ref_at, PRIMARY KEY (repo_id, blob_sha))  -- for src/ GC by date [R:m5]
commits    (repo_id, sha, head_sha, branch, pr INTEGER, base_sha, base_ref, message TEXT, created_at,
            PRIMARY KEY (repo_id, sha))
runs       (id INTEGER PK, repo_id, project_id, sha, head_sha, branch, pr, event, flag, job, language,
            gh_run_id, gh_run_attempt, state TEXT,          -- started | passed | tests_failed | errored |
                                                            -- cancelled | timed_out | lost | no_report | inactive
            started_at, finished_at, deadline_at,
            t_total, t_passed, t_failed, t_errored, t_skipped, duration_ms,
            cov_lines, cov_lines_hit, cov_branches, cov_branches_hit, cov_partial INTEGER,
            patch_lines, patch_lines_hit,
            report_key TEXT, warnings TEXT,
            UNIQUE (repo_id, gh_run_id, gh_run_attempt, flag, job))
failures   (run_id, test_id, suite, name, file, line, status, message TEXT,   -- only non-passing tests,
            is_new INTEGER, is_flaky INTEGER, PRIMARY KEY (run_id, test_id))   -- capped 200 per run
test_stats (project_id, flag, test_id, name, file,                    -- per PROJECT, not per repo [R:N1]:
            fails_30d INTEGER, flips_30d INTEGER, last_status,         -- template children carry identical
            last_fail_sha, last_fail_at, flaky_since TEXT,             -- tests, so a repo key would merge
            PRIMARY KEY (project_id, flag, test_id))                   -- their histories inside diene.all
branch_head(project_id, flag, run_id, PRIMARY KEY (project_id, flag))  -- latest run per project/flag
keep_blobs (project_id, flag, blob_sha, PRIMARY KEY (project_id, flag, blob_sha))  -- blobs used by keep/ reports
```

Indexes: `runs(project_id, flag, finished_at)`, `runs(repo_id, pr, flag)`, `failures(test_id)`.

**Base** = the project's own branch: for a PR, `branch_head(<project of base_ref>, flag)` in the same repo (for a diene.all node,
`base_ref` is the node branch, not `main`); for a push, the previous run on the same branch.

**New failure vs base** [R:m4]: `is_new = 1` when the test id has **no row in the base run's `failures`** — one D1
query, no R2 read, no parsing in the Worker. NEW is only claimed when that base run is **complete**: state `passed`
or `tests_failed`, not coverage-partial, and under the 200-failure cap. Otherwise the Worker walks back to the last
complete run on the base (≤ 10 runs), or shows "NEW: unknown (base run incomplete)" [R:N4].

**Flaky:** a test is marked flaky when (a) it failed and passed on the **same `head_sha`** (re-run attempt, or the
push and PR runs of one commit), or (b) it flipped pass↔fail ≥ 2 times in 30 days on one branch. Flips are found
without the full passing list: the `finish` call first asks the Worker for the ids in `test_stats` with
`last_status = failed` on that project, and the action reports which of them now pass [R:m4]. Only failing tests
and flips write rows, so a green run writes ~4 rows in total.

**Writes are bulk** [R:m5]: failures and `test_stats` upserts go in as one statement each
(`INSERT … SELECT … FROM json_each(?1)`), so a red run is ~6 queries, far under the 50-per-request Free cap.

### 4.3 R2 layout and retention

```
raw/<repo_id>/<sha>/<run_id>-<attempt>/<flag>/<file>.gz     raw tool output                 30 days (lifecycle rule)
rep/<repo_id>/<sha>/<flag>/<run_id>-<attempt>.json.gz       normalized report               90 days
cov/<repo_id>/<sha>/<flag>/<run_id>-<attempt>/<n>.json.gz   per-file coverage, chunked      90 days
src/<repo_id>/<blob_sha>                                    source file, content-addressed  kept while referenced
keep/<repo_id>/<branch>/<flag>.json.gz                      latest default-branch report    never expires
```

R2 lifecycle rules (prefix-based expiry) handle `raw/`, `rep/`, `cov/`. The nightly cron deletes `src/` blobs whose
`blobs.last_ref_at` is older than 90 days and that are not in `keep_blobs` (a D1 query by date, not a scan of
reports) [R:m5][R:N5]. `/sources` re-stamps `last_ref_at` for **every** blob a run lists, not only the missing ones,
and each default-branch `finish` replaces that project's `keep_blobs` rows, and D1 rows older than 180 days except `branch_head`. For runs between 90 and 180 days old the report object is
gone, so pages render the D1 summary only (counts, failures, totals) and say so [R:N8].

### 4.4 Source for the line view

The action uploads the covered source files it holds (content-addressed by git blob SHA, so one copy per
version, ever). This works the same for public and private repos with no GitHub App and no token on the Worker. Files
over 1 MB are skipped and the viewer links to GitHub instead. The Worker **recomputes** `sha1("blob " + len + "\0" +
bytes)` before storing, so a workflow cannot store wrong content under a real blob id [R:m9]. (Alternative considered: the browser fetches from
`raw.githubusercontent.com` — works only for public repos.)

### 4.5 Free-tier fit and cost

Volume model (a busy day = a full cascade): ~100 nodes × ~3 test jobs × 2 repos (diene.all + mirror) ≈ **600
uploads/day**, ~3 requests each.

| Resource | Use on a busy day | Free limit | Paid ($5/mo) |
|---|---|---|---|
| Worker requests | ~2 000 + viewer | 100 000 / day | 10 M / month included |
| Worker CPU | < 5 ms per request by design (§4.1) | **10 ms / request** | 30 s default, 5 min max |
| D1 rows written | ~4 per green run, ≤ ~410 per red run (failures + stats, plus index updates) → ~3 000–30 000 | 100 000 / day | 50 M / month |
| D1 queries per request | ~6 (bulk statements) | **50** | 1 000 |
| D1 rows read | viewer + base lookups, ≪ 1 M | 5 M / day | 25 B / month |
| D1 storage | ~0.5 KB × rows × 180 days ≈ < 200 MB | 500 MB per DB, 5 GB total | 10 GB per DB |
| R2 storage | raw ~100 KB × 600 × 30 d ≈ 1.8 GB + reports ~100 KB × 600 × 90 d ≈ 5.4 GB → **~7 GB** on a cascade every day (much less in practice) [R:m6] | 10 GB-month | $0.015 / GB-month (cents if over) |
| R2 class A (writes) | ~5 per upload → ~3 000/day ≈ 90 000/month | 1 M / month | $4.50 / M |
| Cron triggers | 1 (sweeper + GC, both D1-query only) | 5 per account, **10 ms CPU** | 250 |
| Upload size | ≤ 20 MB (own cap) | 100 MB request body | same |

**Estimate: $0/month on Free; $5/month on Workers Paid.** Recommendation: **Paid** — the design is kept inside Free's
limits (bulk writes, no parsing, date-based GC), but Paid removes the 10 ms / 50-query edges for $5, and nothing in
the design changes either way.
Cloudflare Access: $0 for ≤ 50 users.

## 5. Viewer UI

Plain, server-rendered HTML, one small CSS file, a few KB of JS for the file view; readable on a phone (single
column under 640 px, no horizontal scroll, tap targets ≥ 44 px). Light/dark from the OS.

| Page | Shows |
|---|---|
| `/` | **projects** (repo + branch) [R:M6]: every diene.all node branch is a row, grouped by family; mirror repos show as aliases of their node. Status per flag (✅ / ❌ / ⚠️ errored / ⏱ timed out / 💀 lost) and coverage % |
| `/<owner>/<repo>?branch=<b>` | one project: recent commits, open PRs into it, coverage trend sparkline. Branch names contain `/` (`lib/bun/config`), so branches travel as a query parameter or URL-encoded, never as a path segment |
| `/<owner>/<repo>/commit/<sha>` | **banner** when any run is not `passed` ("Unit tests did not finish: runner lost at 12:03 — job log"); one card per flag (counts, duration, coverage); **failures first**: name, `file:line` (links to GitHub at that SHA), message, folded stack; marks `NEW` (not failing on base) and `FLAKY`; skipped tests folded |
| `/<owner>/<repo>/pull/<n>` | latest `head_sha`, the same cards, **patch coverage** (changed lines hit / changed coverable lines), list of changed files with uncovered changed lines, delta vs base per flag |
| `/<owner>/<repo>/commit/<sha>/coverage[/<flag>]` | file tree with % per folder/file, sortable; merged view across flags or one flag |
| `/<owner>/<repo>/commit/<sha>/file/<path>` | source with hit counts per line (green / red / grey), changed lines marked on PRs |
| `/<owner>/<repo>/test/<test_id>?branch=<b>` | history of one test **in one project** across commits: pass/fail strip, last failure message, flake info |
| `/badge/<owner>/<repo>/<flag>.svg?branch=<b>` | coverage % badge (replaces the Codecov badges in READMEs); `tests.svg` for pass/fail |

PR feedback inside GitHub:

- **v1:** the job summary (`$GITHUB_STEP_SUMMARY`) with counts, failures and a link. Needs no extra permission.
- **v2 (optional):** one sticky PR comment updated per flag (`pull-requests: write` on the calling jobs), or a
  check run per flag (`checks: write`). Both use the job's own `GITHUB_TOKEN` — no GitHub App. The comment is the
  simpler of the two; recommend it only if the job summary turns out to be too hidden.

### 5.1 Access

**Recommendation:** put the whole viewer hostname behind **Cloudflare Access** (Zero Trust, free ≤ 50 users) with
GitHub as the identity provider and an allow-list of the owner's accounts. Add **bypass** policies for
`/api/v1/*` (protected by OIDC instead) and `/badge/*` (numbers only, and only for repos whose stored visibility is
`public`; private repos return a grey "private" badge).

Access can protect a `*.workers.dev` hostname directly, so a custom zone is optional [R:n6].

Why not "public for public repos" in v1: it needs per-page visibility checks and makes a mistake leak private source
(the line view serves source). Turning on public read for public repos is a later, contained change (a
`visibility = 'public'` check on every page + a second Access policy).

## 6. Migration from Codecov

### 6.1 What changes, where

| Origin (ratchet patch) | Files at the origin | Flows to | Notes |
|---|---|---|---|
| `bun-base` | `⚡reusable-test.yaml` (start/finish, `timeout-minutes`), `ci.yaml` unit/int jobs (`id-token: write`), `scripts/ci/test.sh` (`mkdir -p`, `--reporter=junit`, `2>&1 \| tee console.log`) | 22 branches (bun-*, nextjs-frontend, 11 `lib/bun/*`, mercury.webhook, tools/releaser) | 12 different `test.sh` blobs downstream → each cascade step merges by hand |
| `bun-lib` [R:M1] | `ci.yaml` meta job, `scripts/local/test-meta.sh`, bun-lib's own `test.sh` variant (100 % awk gate → `GATE_FAILED` marker) | bun-lib + 11 `lib/bun/*` | `test-meta.sh` exists only from bun-lib down |
| `dotnet-base` | `⚡reusable-test.yaml`, `ci.yaml` unit/int jobs, `scripts/local/dotnet-test.sh` (collector + ReportGenerator local-tool merge, or an xmlstarlet line-sum; gate unchanged on the merged file), test csproj / `Directory.Packages.props` (coverlet.msbuild → coverlet.collector), `nix/dotnet-deps.json` regenerated | 17 branches | today a red .NET run yields **no coverage at all** (spike) [R:M3] |
| `dotnet-lib` [R:M1] | `⚡reusable-test.yaml` variant with the `has-results` gate (drop it; globs instead), `ci.yaml` meta job, its `dotnet-test.sh` variant | dotnet-lib + 11 `lib/dotnet/*` | the gate lives here, not in dotnet-base |
| `go-base` | `⚡reusable-go-test.yaml`, `ci.yaml`, `scripts/local/test.sh` (`--junitfile …`) | 8 branches with the ⚡ name | go int's `sit.sh` step runs after `id: test` → "job failed after tests" row |
| `go-lib` [R:M1] | `reusable-go-test.yaml` (old name, no ⚡), `ci.yaml`, its `local/test.sh` variant | go-lib + 9 `lib/go/*` | the two-filename drift is real (go-lib sits under go-base-wo-helm-docker in the graph); patch both names |
| `dart-lib` | `⚡reusable-test.yaml` (`working-directory: packages/<member>`), `ci.yaml`, `scripts/ci/test.sh` (`--file-reporter=json:…`, `INACTIVE` marker on the no-TestHelper path) | 9 branches | member path differs per node |
| `flutter-base` | `⚡reusable-test.yaml` (one `test` job, no `mode` input → `flag: unit` set by hand; the 165th calling job), `scripts/ci/test.sh` (`--coverage --file-reporter …`) | flutter descendants | adds coverage that never existed |
| **Probes + config** [R:M2] (same 8 origins, second commit) | replace `probes/bun-codecov-config.ts`, `codecov-config.ts`, `dotnet-codecov-config.ts`, `codecov-configuration.ts` (62 branches) with `test-report` probes — **baseline**: start is the first step, finish has `if: always()` + `continue-on-error`, caller grants `id-token: write`, reporter flags present; **mutation**: drop `always()` / drop `id-token` → probe red. Rework `dotnet-multi-project-coverage` for the collector + merge. Update `probes/features.json`. Delete `codecov.yml`/`.codecov.yaml` (66). Update `docs/developer/*-baseline.md` and `docs/standards/ci-cd` | everything above | without this, cut-over turns every node's probes red |
| `workspace` (optional) | `docs/standards/ci-cd/test-reports.md` — the contract: where reports go, the outcome classes, `INACTIVE`/`GATE_FAILED` markers. If the action stays outside AtomiCloud: widen `dlint.yaml` `trustedPattern` | everything | — |
| READMEs | Codecov badge lines (`go-base-badges` fragment etc.) → `/badge/…svg` | 36 of the 66 branches [R:n5] | — |

Also: mirror repos and `diene.all` branches carry the same files, so the mirrors pick the change up through the normal
`.3` mirror step; no per-mirror work.

### 6.2 Order

1. Build the Worker + action (PLAN phases 1–3). Prove on **one scratch repo** first.
2. **Shadow phase:** patch origins to run the new action **next to** Codecov (both steps present). Compare numbers
   on a few nodes for a few days.
3. Remove the Codecov step, `CODECOV_TOKEN` from `workflow_call.secrets`, swap the badges, and remove the
   Codecov probes and `codecov.yml` in the same patch. The **new** test-report probes land earlier, in the shadow
   patch (step 2): both steps are present then, so both probe sets pass [R:N9].
4. Delete `CODECOV_TOKEN` repo/org secrets and uninstall the Codecov GitHub App on ProtoDurian (owner).

Steps 2 and 3 can be one patch if the owner prefers speed over a shadow period; Codecov uploads are already
`fail_ci_if_error: false`, so the shadow phase only buys comparison data.

### 6.3 Rollback

- The new steps are `continue-on-error: true` and never change a job's result, so a broken service cannot break CI.
- Until step 3, rollback = do nothing (Codecov still uploads). After step 3, rollback = revert the patch at the 8
  origins (ratchet patch re-flows it) and re-add `CODECOV_TOKEN`; the Codecov App/account is kept until the new
  system has run clean for 2 weeks.
- Call sites pin `@v1`, so a bad action release is rolled back by moving the `v1` tag back — no cascade.

## 7. Security notes

- No secret is stored anywhere in GitHub for this system. The Worker holds no GitHub credential in v1.
- Report content is untrusted text: escape everything on render (test names and messages can contain HTML); the
  line view renders source as text, never as HTML. Strict CSP: `default-src 'self'`.
- Limits per token: max uploads per `run_id` (e.g. 50) to stop a loop from filling R2.
- Raw files are served only to Access-authenticated users, with `Content-Disposition: attachment`.
- The Worker URL is not secret; the OIDC check is the gate. Rate limiting via a Workers rate-limit binding on
  `/api/v1/*`.

## 8. Alternatives considered

| Option | Why not (for now) |
|---|---|
| Keep Codecov, just re-install on ProtoDurian | Works, but the owner asked to drop it; it also never showed test failures or failed runs. |
| Parse in the Worker | Free plan 10 ms CPU; big XML would fail. Parsing on the runner is free and has no limit. |
| A GitHub App for auth + checks | More moving parts (key, webhook, installation). OIDC + the job token cover v1. Keep as an upgrade path if PR comments must work on forks. |
| `upload-artifact` only + a static viewer reading artifacts | Artifacts need a token to download, expire, and cannot answer "is this test new/flaky" without an index. |
| Self-hosted open-source (e.g. a SonarQube/Allure server) | Needs a server/database to run; the owner asked for a Cloudflare personal thing. |
| JUnit everywhere via extra loggers (JunitXml.TestLogger, `tojunit`) | Adds packages to 26 branches and still loses detail (Dart JSON has more than its JUnit conversion). Native formats are parsed directly instead. |

## 9. Risks, unknowns and the spikes that settle them

| # | Unknown | Spike (before or in phase 1) | If it fails |
|---|---|---|---|
| S1 | OIDC token on **Namespace** runners | one workflow on a Namespace runner with `id-token: write`; print decoded claims | run the `finish` upload in a tiny follow-up job on `ubuntu-latest` that downloads the report artifact (adds ~20 s) |
| S2 | Does an `if: always()` step run after a **job-level timeout**? (community reports: usually yes, ~4–5 min grace) | job with `timeout-minutes: 1` and `sleep 120` | the `lost` sweeper still records it; only the files are missing. Use step-level `timeout-minutes` on the test step so the job itself is not cancelled |
| S3 | Dependabot PRs: is `id-token: write` honoured? (sources disagree) | open one Dependabot PR on a scratch repo | treat Dependabot like forks (artifact only) |
| S4 | .NET: coverlet **collector** on the real multi-project dotnet-lib (include/exclude filters move from `/p:` to runsettings, `[Lib*]*` ledgers, ReportGenerator as a dotnet local tool (not in nixpkgs) or an xmlstarlet merge, the per-package threshold check on the merged file, the `dotnet-multi-project-coverage` probe, `nix/dotnet-deps.json` regeneration) — the MSBuild-on-failure gap itself is already proven (`spikes/dotnet/`) | one real dotnet-lib run, unit + int, one failing test | keep coverlet MSBuild and accept "no coverage" on red .NET runs (TRX still gives every failure) |
| S5 | Flutter `--file-reporter=json:` support and `--coverage` with failing tests | flutter-base scratch run | parse `flutter test --machine` stdout (same JSON events) via `tee` |
| S6 | Bun: failure text only in console output; load errors missing from JUnit | already reproduced (`spikes/bun/`) | the console-log parser is part of the action from day 1; re-check on each Bun bump (upstream PRs #44434/#44435 may fix it) |
| S7 | Go panics drop the panicking binary's coverage across every `-coverpkg` package | reproduced (`spikes/go/unit.out`) | shown as `partial`; not fixable without changing how Go writes profiles |
| S8 | Ratchet: the go family has two filenames for the same workflow | read the go-base fragment map during patch authoring | patch both names explicitly |
| S9 | Report size on the biggest nodes (nextjs-frontend, dotnet api-engine) | measure from the existing `coverage-*` artifacts of a recent run | chunk `cov/` objects (already in the layout) |
| S10 | Path mapping: coverlet Cobertura `<source>` roots, Dart absolute `SF:`, Go module prefix, nix-store paths | parser unit tests on real files from each family | per-language path rule + `warnings` |
| S11 | CI is currently blocked (Namespace/no runners per `feasibility/summary.md`) | — | the build can proceed and be proven on GitHub-hosted runners in a scratch repo; rollout waits for CI to be healthy |

## 10. Decisions the owner should make (with recommendations)

1. **Domain / hostname** — a subdomain on a zone already in the Cloudflare account, or plain `*.workers.dev` (Access
   can protect it directly).
2. **Workers plan** — recommend Paid $5/month; Free works but sits close to its CPU/query edges.
3. **Viewer access** — recommend Access for everything, bypass for ingest + badges (§5.1).
4. **Fork/Dependabot** — recommend artifact-only in v1 (§3.5).
5. **Shadow period** — recommend 1 week next to Codecov, then remove.
6. **Action repo home** — recommend **`AtomiCloud/actions.test-report`** (public), next to `actions.setup-nix`, pinned
   `@v1`. A ProtoDurian home works only if `workspace`'s `dlint.yaml` `trustedPattern` is widened; otherwise the
   lint forces SHA pins and every parser fix becomes a cascade [R:M4].
