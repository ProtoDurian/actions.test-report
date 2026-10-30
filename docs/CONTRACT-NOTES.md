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
   (`$RUNNER_TEMP/diene-report-<flag>.json`). The `timeout-minutes` input wins
   over the state file when both are set.
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

14. **Rate limit vs chunking.** The Worker allows 60 writes per
    `(repository_id, run_id, run_attempt)`, shared across all jobs of a run.
    Per job this action sends at most 6 raw files and 20 source blobs, and when
    any call still returns 429 after its retries it skips the remaining
    optional uploads (raw, sources). `finish`, `report` and `cov/n` are always
    attempted first.
15. **`finish` is the only fatal step.** If it fails the action falls back to the
    artifact. Failures of report / cov / raw / sources are warnings.
16. **Fresh OIDC token per HTTP attempt**, including retries, so a long backoff
    never sends an expired token.
17. **Summary trimming** when the summary is over 2 MB: drop `sources`, then
    `failures`, then `patch`, then coverage files, then set `overCap: true` and
    send nothing but the summary.
18. **`comment` input** is declared (reserved by the design) and ignored.

## Fallback

19. **No OIDC** (fork PR, missing `id-token: write`) or a failed `finish`: the
    action still parses, classifies and writes the step summary, then uploads
    artifact `test-report-<flag>` with `summary.json` and `report.json`
    (summary only when over cap). If the artifact upload also fails it only
    warns.
