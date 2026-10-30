const NOISE = /^\s*(=== (RUN|PAUSE|CONT|NAME)\b|--- (FAIL|PASS|SKIP):)/;
const GOROOT = /\/(share\/go\/src|go\/src|pkg\/mod)\/|^\/nix\/store\/[^/]+-go-/;

/** Split `go test` failure output into a message and (for panics) the goroutine trace. */
export function cleanGoOutput(raw: string): { message: string; stack: string | null } {
  const lines = raw.split('\n').filter(l => !NOISE.test(l));
  const text = lines.join('\n').trim();
  const g = text.search(/(^|\n)goroutine \d+ \[/);
  if (g >= 0) {
    return { message: text.slice(0, g).trim(), stack: text.slice(g).trim() };
  }
  return { message: text, stack: null };
}

/** First useful `file.go:LINE` in a Go failure: `    calc_test.go:10: ...` or a non-GOROOT trace frame. */
export function goLocation(message: string, stack: string | null): { file: string; line: number; absolute: boolean } | null {
  const m = /^\s*([\w./-]+\.go):(\d+)(?::|\b)/m.exec(message);
  if (m && !m[1]!.startsWith('/')) return { file: m[1]!, line: Number(m[2]), absolute: false };
  const traces = (message + '\n' + (stack ?? '')).split('\n');
  for (const l of traces) {
    const t = /^\s+(\S+\.go):(\d+)\b/.exec(l);
    if (t && !GOROOT.test(t[1]!)) return { file: t[1]!, line: Number(t[2]), absolute: t[1]!.startsWith('/') };
  }
  return null;
}
