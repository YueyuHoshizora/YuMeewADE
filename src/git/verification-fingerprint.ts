import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import { git } from './git.ts';
import { parseVerificationInputModel, type VerificationInputModel } from '../shared/verification.ts';

function glob(pattern: string): RegExp {
  let expression = '';
  const parts = pattern.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === '**') expression += index === parts.length - 1 ? '.*' : '(?:[^/]+/)*';
    else expression += part.split('*').map(text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*') + (index < parts.length - 1 ? '/' : '');
  }
  return new RegExp(`^${expression}(?:/.*)?$`, 'u');
}

/** 保守策略：除 Git 管理資料外連 ignored/generated 檔也納入，不把可能的輸入當作輸出忽略。 */
export async function verificationFingerprint(root: string, configuration: string, value?: VerificationInputModel): Promise<string> {
  root = await fs.realpath(root);
  const model = parseVerificationInputModel(value);
  const inputs = model.inputs?.map(glob);
  const outputs = model.outputs?.map(glob) ?? [];
  const included = (relative: string) => !inputs || inputs.some(pattern => pattern.test(relative));
  const excluded = (relative: string) => outputs.some(pattern => pattern.test(relative)) && !(inputs?.some(pattern => pattern.test(relative)));
  // Literal prefixes bound traversal without trusting filesystem metadata as content proof.
  const prefixes = model.inputs?.map(pattern => pattern.split('/').slice(0, pattern.split('/').findIndex(part => part.includes('*')) < 0 ? undefined : pattern.split('/').findIndex(part => part.includes('*'))).join('/'));
  const mayContain = (relative: string) => !prefixes || prefixes.some(prefix => !prefix || prefix === relative || prefix.startsWith(`${relative}/`) || relative.startsWith(`${prefix}/`));
  const digest = createHash('sha256');
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.code < 0 || head.truncated) throw new AppError('internal', 'git_failed');
  digest.update(JSON.stringify([root, configuration, model, head.code === 0 ? head.stdout.trim() : null]));
  async function hashFile(file: string, expected: Stats): Promise<void> {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      const resolved = await fs.realpath(file);
      if (!isInside(root, resolved)) throw new AppError('bad_request');
      const currentPath = await fs.stat(resolved);
      if (!before.isFile() || before.dev !== currentPath.dev || before.ino !== currentPath.ino || before.dev !== expected.dev || before.ino !== expected.ino) throw new AppError('conflict');
      digest.update(JSON.stringify([before.mode, before.size, before.mtimeMs, before.ctimeMs]));
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AppError('conflict');
      digest.update('\0');
    } finally { await handle.close(); }
  }
  async function visit(dir: string): Promise<void> {
    const canonical = await fs.realpath(dir);
    if (canonical !== root && !isInside(root, canonical)) throw new AppError('bad_request');
    const directory = await fs.stat(dir);
    // Directory timestamps change when atomic history writes rename temporary files.
    // Names/content still fingerprint every non-managed entry, including ignored inputs.
    digest.update(JSON.stringify([path.relative(root, dir), directory.mode, directory.ino, directory.dev]));
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const managed = path.relative(root, path.join(dir, entry.name)).split(path.sep);
      if (entry.isFile() && managed.length === 3 && managed[0] === '.ai' && managed[1] === 'verification' && /^[A-Za-z0-9_-]+(?:\.tests)?\.json(?:\.\d+\.[a-f0-9-]+\.tmp)?$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file);
      const portable = relative.split(path.sep).join('/');
      const directoryLike = entry.isDirectory() || entry.isSymbolicLink();
      if (excluded(portable) && (!directoryLike || !inputs || !mayContain(portable))) continue;
      if (directoryLike ? !mayContain(portable) : !included(portable)) continue;
      const stat = await fs.lstat(file);
      digest.update(JSON.stringify(stat.isDirectory()
        ? [relative, stat.mode, stat.ino, stat.dev]
        : [relative, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]));
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(file);
        if ((target !== root && !isInside(root, target)) || path.relative(root, target).split(path.sep).includes('.git')) throw new AppError('bad_request');
        digest.update(JSON.stringify(['link', await fs.readlink(file)]));
        const linked = await fs.stat(target);
        if (linked.isFile()) await hashFile(target, linked);
        else if (!linked.isDirectory() || model.inputs || model.outputs?.length) throw new AppError('bad_request');
      } else if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        await hashFile(file, stat);
      } else throw new AppError('bad_request');
    }
  }
  await visit(root);
  return digest.digest('hex');
}
