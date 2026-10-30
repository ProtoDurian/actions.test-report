import { spawnSync } from 'node:child_process';
import type { Language } from './types';

const CMD: Partial<Record<Language, [string, string[]]>> = {
  bun: ['bun', ['--version']],
  go: ['go', ['version']],
  dotnet: ['dotnet', ['--version']],
  dart: ['dart', ['--version']],
};

/** "go version go1.25.1 linux/amd64" -> "go 1.25.1"; best effort, null when the tool is absent. */
export function parseToolVersion(language: Language, out: string): string | null {
  const text = out.trim().split('\n')[0] ?? '';
  const v = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(text)?.[1];
  if (!v) return null;
  return `${language === 'dotnet' ? 'dotnet' : language} ${v}`;
}

export function detectTool(language: Language): string | null {
  const c = CMD[language];
  if (!c) return null;
  try {
    const r = spawnSync(c[0], c[1], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return null;
    return parseToolVersion(language, `${r.stdout}\n${r.stderr}`);
  } catch {
    return null;
  }
}
