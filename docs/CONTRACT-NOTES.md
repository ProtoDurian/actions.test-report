# Contract notes

Places where `CONTRACT.md` / `DESIGN.md` were ambiguous, and the reading this
action implements. `CONTRACT.md` is unchanged.

## Test identity and display

1. **Go identity is the import path.** `testcase@classname` is the Go package
   import path, so the native identity is `${classname}.${name}`. The `suite`
   shown to users is the repo-relative directory (import path mapped through the
   `go.mod` `module` line), so identity stays stable if the module is renamed
   only in display, not in id.
2. **Duplicate identities** get a `#2`, `#3` ... suffix on the second and later
   occurrence (in file order) before hashing. Ids never include file or line.
3. **`message` in `failures[]` is `""`, not `null`,** when a failing test has no
   text at all (keeps the summary schema string-only).

## Outcome rules (CONTRACT §5)

4. **Rule 2 "no tests"** is read as: no test file found, or a test file with
   zero cases. An `INACTIVE` marker plus that gives `inactive`; the marker with
   tests present is ignored.
5. **Passed with failures in the report.** If the step succeeded but the report
   holds failed tests, the class stays `passed` (the step is the authority) and a
   note is added to `outcome.notes`.
6. **Gate vs crash.** `errored` with `subReason: gate` needs the `GATE_FAILED`
   marker or a console line matching `❌ ... coverage`. Anything else is `crash`.
7. **`startedAt`** comes from the start-mode state file
   (`$RUNNER_TEMP/diene-report-<flag>.json`). `timeout-minutes` has no default:
   pass it on `start` and `finish` reads it back from the state file. An
   explicit input on `finish` wins over the state file; with neither it is 30.
8. **A Go coverprofile with no blocks but failing tests** (empty profile after a
   build failure or panic) is treated as `partial`.

## Parsing

9. **Bun failure text** is taken from the console log, matched on
   `describe > name` against the stderr block printed before each `(fail)` line.
   Without a console log Bun failures have no message.
10. **Cobertura** is class-level: line hits are merged per line number with the
    maximum hit count (a line shared by several classes/methods is not double
    counted). `<sources>` roots (including `/`) are stripped, then paths are
    resolved against the repo root.
11. **Numeric XML entities** (`&#xA;` in Go and TRX messages) need
    `htmlEntities: true` in `fast-xml-parser` v5; it is on for every parse.
12. **`tool`** is detected by running `<tool> --version` (go, bun, dotnet,
    dart). It is `null` for flutter and generic, and on any failure.
13. **Spike fixtures** contained `<scratch>` placeholders that broke the XML;
    they were replaced by `/tmp/scratch`. The meaning of the fixtures is
    unchanged.

## Upload

14. **Rate limit.** The Worker allows 2000 writes per test job
    (`repository_id`, `run_id`, `run_attempt`, `flag`, `job`), so there is no
    client-side cap: every raw file and every missing source blob is uploaded.
    `/sources/check` and `PUT /sources/:blob` carry `?flag=<flag>&job=<job>`.
    If any optional call still returns 429 after its retries, the remaining
    optional uploads (raw, sources) are skipped with a warning. `finish`,
    `report` and `cov/n` are always attempted first.
    Every HTTP attempt has a 30 s `AbortSignal.timeout`, and the whole upload
    has a 4 minute budget; once it is used up the remaining uploads (report,
    cov, raw, sources) are skipped with one warning. `finish` is always
    attempted. Source blobs are uploaded 6 at a time.
    The endpoint must be `https` (the OIDC token goes there); `http` is only
    accepted for `localhost`, `127.0.0.1` and `[::1]`.
15. **`finish` is the only fatal step.** If it fails the action falls back to the
    artifact. Failures of report / cov / raw / sources are warnings.
16. **Fresh OIDC token per HTTP attempt**, including retries, so a long backoff
    never sends an expired token.
17. **Summary trimming** when the summary is over 2 MB: drop `sources` (the
    report, cov chunks and raw files are still sent), then shorten `failures`,
    then `patch`, then drop per-file coverage. Only that last step sets
    `overCap: true`, and then nothing but the summary is sent (`raw` and
    `sources` are cleared). The summary is trimmed again after the recovered ids
    are added, so `finish` stays under 2 MB.
18. **`comment` input** is declared (reserved by the design) and ignored.

## Fallback

19. **No OIDC** (fork PR, missing `id-token: write`) or a failed `finish`: the
    action still parses, classifies and writes the step summary, then uploads
    artifact `test-report-<flag>` with `summary.json` and `report.json`
    (summary only when over cap). If the artifact upload also fails it only
    warns.
    If `test-report-<flag>` already exists in the run (matrix jobs sharing a
    flag, HTTP 409) the upload is retried once as
    `test-report-<flag>-<job>-<runAttempt>`.

## Added after review

20. **Branch coverage merge.** When the same file is reported by several
    coverage files, the hit count of a branch is the larger of the two, never
    the sum. This is a lower bound, so merged branch % can be understated but
    never inflated.
21. **Crash reasons.** A Dart `loading <file>` test that ends in error (load or
    compile failure) and a TRX `RunInfo` with outcome `Error` that is not a
    plain `[FAIL]`/`[SKIP]` line become outcome notes and show in the step
    summary. They never become test cases, so the class stays
    `errored:crash` rather than `tests_failed`.
22. **Dart `root_line`.** When a test's `url` is not its suite file (declared in
    a helper), the call-site `root_line` is used as `line`.
23. **Diff parsing.** `+++` is only a file header between `diff --git` and the
    first hunk. Quoted paths are un-quoted before the `b/` prefix is stripped,
    and C-style octal escapes are decoded.
24. **Escaping.** Failure file names and outcome notes (which can contain server
    error bodies) are HTML-escaped in the step summary.
