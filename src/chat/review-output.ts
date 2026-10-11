import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git, gitOk, isRepo } from '../git/git.ts';
import { AppError } from '../shared/errors.ts';
import type { ReviewFinding } from '../shared/review-types.ts';

export const REVIEW_PROTOCOL = 'Return ONLY a JSON object: {"schema":1,"approved":boolean,"findings":[{"severity":"critical|major|minor|info","path":"relative/file","line":1,"message":"finding","evidence":"specific evidence"}]}. Approval must be explicit; approve only when no unresolved critical or major findings exist. Never change files.';
export function parseReviewOutput(text: string): { structured: boolean; approved: boolean; findings: ReviewFinding[] } {
  const invalid = { structured: false, approved: false, findings: [] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid; }
  if (!value || typeof value !== 'object') return invalid;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || typeof record.approved !== 'boolean' || !Array.isArray(record.findings) || record.findings.length > 200) return invalid;
  const findings: ReviewFinding[] = [];
  for (const item of record.findings) {
    if (!item || typeof item !== 'object') return invalid;
    const f = item as Record<string, unknown>;
    if (!['critical', 'major', 'minor', 'info'].includes(String(f.severity)) || typeof f.path !== 'string' || !f.path || f.path.length > 1000
      || f.path.startsWith('/') || f.path.includes('\\') || /^[A-Za-z]:/.test(f.path) || f.path.split('/').some(p => p === '..' || p === '.' || !p)
      || !Number.isSafeInteger(f.line) || Number(f.line) < 1 || typeof f.message !== 'string' || !f.message.trim() || f.message.length > 10000
      || typeof f.evidence !== 'string' || !f.evidence.trim() || f.evidence.length > 10000) return invalid;
    findings.push({ id: randomUUID(), severity: f.severity as ReviewFinding['severity'], path: f.path, line: Number(f.line), message: f.message, evidence: f.evidence, state: 'open', transitions: [] });
  }
  return { structured: true, approved: record.approved && !findings.some(f => f.severity === 'major' || f.severity === 'critical'), findings };
}

/** Hash the complete tracked/nonignored content, not timestamps or a truncated diff. */
export async function reviewFingerprint(cwd: string): Promise<{ revision: string; content: string }> {
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const revision = head.code === 0 ? head.stdout.trim() : 'unborn';
  const files: string[] = [];
  if (await isRepo(cwd)) files.push(...(await gitOk(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBytes: 2_000_000 })).split('\0').filter(Boolean));
  else {
    const pending = [''];
    while (pending.length) {
      const relative = pending.pop()!;
      for (const entry of await fs.readdir(path.join(cwd, relative), { withFileTypes: true })) {
        if (entry.name === '.ai' || entry.name === '.git') continue;
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) pending.push(name); else files.push(name);
        if (files.length + pending.length > 50000) throw new AppError('conflict');
      }
    }
  }
  if (files.length > 50000) throw new AppError('conflict');
  const hash = createHash('sha256'); let bytes = 0;
  const root = await fs.realpath(cwd); const absoluteRoot = path.resolve(cwd);
  for (const name of [...new Set(files)].sort()) {
    if (name.split('/').includes('.ai')) continue;
    const file = path.resolve(cwd, name);
    if (!file.startsWith(absoluteRoot + path.sep)) throw new AppError('conflict');
    const parent = await fs.realpath(path.dirname(file)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (parent && parent !== root && !parent.startsWith(root + path.sep)) throw new AppError('conflict');
    hash.update(name + '\0');
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) hash.update('link:' + await fs.readlink(file));
      else if (stat.isFile()) {
        if (bytes + stat.size > 100_000_000) throw new AppError('conflict');
        const handle = await fs.open(file, 'r');
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            bytes += chunk.length; if (bytes > 100_000_000) throw new AppError('conflict');
            hash.update(chunk);
          }
        } finally { await handle.close(); }
        hash.update(String(stat.mode));
      } else hash.update('nonfile');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted'); else throw error; }
    hash.update('\0');
  }
  return { revision, content: hash.digest('hex') };
}
