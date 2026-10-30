# actions.test-report

GitHub Action that parses test + coverage results (Bun/TS, Go, .NET, Dart,
Flutter, generic JUnit) and uploads them to a `diene-reports` server. It reports
failed tests, failed test runs, and still reports whatever test and coverage
results exist. It never fails your job.

```yaml
permissions:
  contents: read
  id-token: write # OIDC token for the upload

steps:
  - uses: ProtoDurian/actions.test-report@v1
    with: { mode: start, flag: unit, language: bun }
  - uses: actions/checkout@v7
  - id: test
    run: bun run test:ci
  - uses: ProtoDurian/actions.test-report@v1
    if: always()
    with:
      mode: finish
      flag: unit
      language: bun
      test-outcome: ${{ steps.test.outcome }}
      job-status: ${{ job.status }}
```

## Inputs

| input | default | meaning |
|---|---|---|
| `mode` | | `start` (first step) or `finish` (`if: always()`) |
| `flag` | | name of this test run, e.g. `unit` |
| `language` | `generic` | `bun`, `go`, `dotnet`, `dart`, `flutter`, `generic` |
| `tests` | per language | newline-separated globs; required for `generic` |
| `coverage` | per language | newline-separated globs |
| `console-log` | per language | console log (Bun failure text, coverage gate detection) |
| `working-directory` | `.` | globs are relative to it |
| `test-outcome` | | `steps.<id>.outcome` of the test step |
| `job-status` | | `job.status` |
| `timeout-minutes` | _(30)_ | job timeout; pass on `start`, `finish` reuses it. Tells `timed_out` from `cancelled` |
| `endpoint` | `https://reports.atomi.cloud` | server; must be https (http only for localhost) |

Outputs: `run-url`, `class` (`passed`, `tests_failed`, `errored`, `cancelled`,
`timed_out`, `inactive`, `no_report`).

## Default globs (relative to `working-directory`)

| language | tests | coverage | console log |
|---|---|---|---|
| bun | `reports/<flag>/junit.xml` | `coverage/<flag>/lcov.info` | `reports/<flag>/console.log` |
| go | `reports/<flag>/junit.xml` | `coverage/<flag>.out` | none |
| dotnet | `TestResults/<flag>/**/*.trx` | `TestResults/<flag>/**/coverage.cobertura.xml` | none |
| dart | `reports/<flag>/test.json` | `coverage/<flag>/lcov.info` | none |
| flutter | `reports/<flag>/test.json` | `coverage/lcov.info` | none |
| generic | `tests` input | optional | none |

File formats are detected from content (JUnit, TRX, Cobertura, Dart JSON,
LCOV, Go coverprofile).

## Without a server

On fork PRs (no OIDC) or when the server is down, the action still writes the
job summary and uploads artifact `test-report-<flag>`.

## Development

```
bun install
bun run typecheck && bun run test
bun run build   # commit dist/index.js; CI fails if it is stale
```

Wire format: [docs/CONTRACT.md](docs/CONTRACT.md). Ambiguities and how they were
resolved: [docs/CONTRACT-NOTES.md](docs/CONTRACT-NOTES.md).
