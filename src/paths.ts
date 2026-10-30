import { posix } from 'node:path';
import { toPosix } from './util';

export interface GoModule {
  dir: string;
  module: string;
}

export interface PathCtx {
  repoRoot: string;
  /** absolute working directory the tool ran in */
  workDir: string;
  tracked: Set<string>;
  goModules: GoModule[];
}

const NIX = /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/(.+)$/;
const ABS = /^(\/|[A-Za-z]:\/)/;
const MAX_WARN = 50;

/** Everything becomes a repo-root-relative POSIX path; untracked paths are kept and warned about. */
export class PathResolver {
  readonly warnings: string[] = [];
  private warned = new Set<string>();
  private extra = 0;
  private readonly root: string;
  private readonly wdRel: string;

  constructor(private readonly ctx: PathCtx) {
    this.root = toPosix(ctx.repoRoot).replace(/\/$/, '');
    const wd = toPosix(ctx.workDir).replace(/\/$/, '');
    this.wdRel = wd === this.root ? '' : wd.startsWith(this.root + '/') ? wd.slice(this.root.length + 1) : '';
  }

  get knowsTracked(): boolean {
    return this.ctx.tracked.size > 0;
  }

  /** Repo-relative dir of a Go package (import path or already-relative dir). */
  goPackageDir(pkg: string): string {
    for (const m of this.ctx.goModules) {
      if (pkg === m.module) return m.dir || '.';
      if (pkg.startsWith(m.module + '/')) return posix.join(m.dir, pkg.slice(m.module.length + 1));
    }
    return pkg;
  }

  /** Resolve `p` (as written by a tool). `candidates` are tried first (already-joined guesses). */
  resolve(p: string, opts: { bases?: string[]; candidates?: string[]; go?: boolean; what?: string; quiet?: boolean } = {}): string {
    let s = toPosix(p).trim().replace(/^file:\/\//, '');
    if (opts.go) {
      const dir = this.goModuleFile(s);
      if (dir !== null) s = dir;
    }
    const tries: string[] = [...(opts.candidates ?? [])];
    if (opts.bases?.length && !ABS.test(s)) for (const b of opts.bases) tries.push(posix.join(toPosix(b), s));
    tries.push(s);
    let fallback: string | null = null;
    for (const t of tries) {
      const r = this.one(t);
      if (r.tracked) return r.path;
      fallback ??= r.path;
    }
    const out = fallback ?? s;
    if (this.knowsTracked && !opts.quiet) this.warn(`${opts.what ?? 'path'} not tracked by git: ${s}`);
    return out;
  }

  private goModuleFile(s: string): string | null {
    for (const m of this.ctx.goModules) {
      if (s.startsWith(m.module + '/')) return posix.join(m.dir, s.slice(m.module.length + 1));
    }
    return null;
  }

  private one(s: string): { path: string; tracked: boolean } {
    const t = this.ctx.tracked;
    if (ABS.test(s)) {
      if (s.startsWith(this.root + '/')) {
        const rel = posix.normalize(s.slice(this.root.length + 1));
        return { path: rel, tracked: t.has(rel) };
      }
      const nix = NIX.exec(s);
      if (nix && t.has(nix[1]!)) return { path: nix[1]!, tracked: true };
      const suf = this.suffix(s);
      if (suf) return { path: suf, tracked: true };
      return { path: nix ? s : s, tracked: false };
    }
    const rel = posix.normalize(s.replace(/^\.\//, ''));
    const withWd = this.wdRel ? posix.join(this.wdRel, rel) : rel;
    if (t.has(withWd)) return { path: withWd, tracked: true };
    if (t.has(rel)) return { path: rel, tracked: true };
    const suf = rel.includes('/') ? this.suffix(withWd) : null;
    if (suf) return { path: suf, tracked: true };
    return { path: withWd, tracked: false };
  }

  /** longest tracked suffix with at least two segments (or the whole path) */
  private suffix(abs: string): string | null {
    const segs = abs.split('/').filter(Boolean);
    for (let i = 0; i <= Math.max(0, segs.length - 2); i++) {
      const cand = segs.slice(i).join('/');
      if (this.ctx.tracked.has(cand)) return cand;
    }
    return null;
  }

  private warn(w: string): void {
    if (this.warned.has(w)) return;
    this.warned.add(w);
    if (this.warnings.length < MAX_WARN) this.warnings.push(w);
    else this.extra++;
  }

  allWarnings(): string[] {
    return this.extra ? [...this.warnings, `…and ${this.extra} more untracked path(s)`] : [...this.warnings];
  }
}
