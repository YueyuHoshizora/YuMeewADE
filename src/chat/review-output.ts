import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git, gitOk, isRepo } from '../git/git.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
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
    if (typeof f.severity !== 'string' || !['critical', 'major', 'minor', 'info'].includes(f.severity) || typeof f.path !== 'string' || !f.path || f.path.length > 1000
      || f.path.startsWith('/') || f.path.includes('\\') || /^[A-Za-z]:/.test(f.path) || f.path.split('/').some(p => p === '..' || p === '.' || !p)
      || !Number.isSafeInteger(f.line) || Number(f.line) < 1 || typeof f.message !== 'string' || !f.message.trim() || f.message.length > 10000
      || typeof f.evidence !== 'string' || !f.evidence.trim() || f.evidence.length > 10000) return invalid;
    findings.push({ id: randomUUID(), severity: f.severity as ReviewFinding['severity'], path: f.path, line: Number(f.line), message: f.message, evidence: f.evidence, state: 'open', transitions: [] });
  }
  return { structured: true, approved: record.approved && !findings.some(f => f.severity === 'major' || f.severity === 'critical'), findings };
}

/**
 * Hash the complete tracked/nonignored content, not timestamps or a truncated diff. Every entry is one JSON record with
 * its own content digest, so bytes in one file can never pass for another file's name or metadata. A submodule counts by
 * the commit staged for it and, recursively, by its own content. `ledger`: the project's ledger folder; only when `cwd`
 * is that folder is its top-level `.ai/` (chat, tasks, reviews — rewritten by the review itself) left out. A project's
 * own `.ai` directories elsewhere are content like any other.
 */
export async function reviewFingerprint(cwd: string, ledger?: string): Promise<{ revision: string; content: string }> {
  const skipLedger = ledger !== undefined && await fs.realpath(ledger).catch(() => path.resolve(ledger)) === await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const revision = head.code === 0 ? head.stdout.trim() : 'unborn';
  const files: string[] = [];
  const gitlinks = new Map<string, string>();
  if (await isRepo(cwd)) {
    files.push(...(await gitOk(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBytes: 2_000_000 })).split('\0').filter(Boolean));
    for (const entry of (await gitOk(cwd, ['ls-files', '-z', '--stage'], { maxBytes: 4_000_000 })).split('\0')) {
      const staged = /^160000 ([0-9a-f]+) \d\t(.+)$/su.exec(entry);
      if (staged) gitlinks.set(staged[2]!, staged[1]!);
    }
  }
  else {
    const pending = [''];
    while (pending.length) {
      const relative = pending.pop()!;
      for (const entry of await fs.readdir(path.join(cwd, relative), { withFileTypes: true })) {
        if ((relative === '' && entry.name === '.ai' && skipLedger) || entry.name === '.git') continue;
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) pending.push(name); else files.push(name);
        if (files.length + pending.length > 50000) throw new AppError('conflict');
      }
    }
  }
  if (files.length > 50000) throw new AppError('conflict');
  const outer = createHash('sha256'); let bytes = 0;
  const root = await fs.realpath(cwd); const absoluteRoot = path.resolve(cwd);
  for (const name of [...new Set(files)].sort()) {
    if (skipLedger && name.split(/[\\/]/)[0] === '.ai') continue;
    const file = path.resolve(cwd, name);
    if (!isInside(absoluteRoot, file)) throw new AppError('conflict');
    const parent = await fs.realpath(path.dirname(file)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (parent && parent !== root && !isInside(root, parent)) throw new AppError('conflict');
    let record: unknown[];
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) record = ['link', await fs.readlink(file)];
      else if (stat.isFile()) {
        if (bytes + stat.size > 100_000_000) throw new AppError('conflict');
        const hash = createHash('sha256');
        const handle = await fs.open(file, 'r');
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            bytes += chunk.length; if (bytes > 100_000_000) throw new AppError('conflict');
            hash.update(chunk);
          }
        } finally { await handle.close(); }
        record = ['file', hash.digest('hex'), stat.mode];
      } else if (stat.isDirectory() && gitlinks.has(name)) {
        const nested = await isRepo(file) ? await reviewFingerprint(file) : null;
        record = ['gitlink', gitlinks.get(name), nested?.revision ?? null, nested?.content ?? null];
      } else record = ['nonfile'];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') record = ['deleted']; else throw error; }
    outer.update(`${JSON.stringify([name, ...record])}\n`);
  }
  return { revision, content: outer.digest('hex') };
}
