/** `git diff -U0` -> added/changed line numbers (new side) per repo-relative path. */
export function parseDiff(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('+++ ')) {
      const p = l.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '').replace(/^"(.*)"$/, '$1');
      if (file && !out.has(file)) out.set(file, []);
    } else if (file && l.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const arr = out.get(file)!;
      for (let i = 0; i < count; i++) arr.push(start + i);
    }
  }
  for (const [k, v] of out) if (!v.length) out.delete(k);
  return out;
}
