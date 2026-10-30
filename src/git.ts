import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 256 * 1024 * 1024;

function git(cwd: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: MAX, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
}

export function repoRoot(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

/** tracked path -> blob sha (submodules skipped) */
export function lsFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = git(root, ['ls-files', '-s', '-z']).toString('utf8');
    for (const rec of raw.split('\0')) {
      const m = /^(\d+) ([0-9a-f]{40}) \d\t(.+)$/s.exec(rec);
      if (m && m[1] !== '160000') out.set(m[3]!, m[2]!);
    }
  } catch {
    // not a git repo or git missing: callers treat an empty map as "unknown"
  }
  return out;
}

export function diffMergeParent(root: string): string | null {
  try {
    return git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD^1', 'HEAD']).toString('utf8');
  } catch {
    return null;
  }
}

/** blob sha -> size in bytes, for those that exist */
export function blobSizes(root: string, shas: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!shas.length) return out;
  try {
    const raw = git(root, ['cat-file', '--batch-check'], shas.join('\n') + '\n').toString('utf8');
    for (const l of raw.split('\n')) {
      const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(l);
      if (m) out.set(m[1]!, Number(m[2]));
    }
  } catch {
    // ignore
  }
  return out;
}

export function blobContent(root: string, sha: string): Buffer {
  return git(root, ['cat-file', 'blob', sha]);
}

/** `module` lines of every tracked go.mod: [{dir (repo-relative, '' for root), module}] */
export function goModules(root: string, tracked: Iterable<string>): { dir: string; module: string }[] {
  const mods: { dir: string; module: string }[] = [];
  for (const p of tracked) {
    if (p !== 'go.mod' && !p.endsWith('/go.mod')) continue;
    if (mods.length >= 200) break;
    try {
      const m = /^module\s+("?)(\S+?)\1\s*$/m.exec(readFileSync(join(root, p), 'utf8'));
      if (m) mods.push({ dir: p === 'go.mod' ? '' : p.slice(0, -'/go.mod'.length), module: m[2]! });
    } catch {
      // unreadable go.mod: skip
    }
  }
  return mods.sort((a, b) => b.module.length - a.module.length);
}
