/** Undo git's C-style quoting ("\\303\\251.ts" -> é.ts). */
function unquote(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const n = body[++i] ?? '';
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' };
      bytes.push(...Buffer.from(map[n] ?? n, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `git diff -U0` -> added/changed line numbers (new side) per repo-relative path. */
export function parseDiff(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  // file headers only count between "diff --git" and the first hunk, so an added line like "++ x" is never a header
  let inHeader = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
    } else if (inHeader && l.startsWith('+++ ')) {
      const p = unquote(l.slice(4).replace(/\t.*$/, '').trim());
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, []);
    } else if (l.startsWith('@@')) {
      inHeader = false;
      if (!file) continue;
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
