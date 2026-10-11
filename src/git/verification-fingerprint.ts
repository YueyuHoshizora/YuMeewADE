import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import { git } from './git.ts';

/** 保守策略：除 Git 管理資料外連 ignored/generated 檔也納入，不把可能的輸入當作輸出忽略。 */
export async function verificationFingerprint(root: string, configuration: string): Promise<string> {
  const digest = createHash('sha256');
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.code < 0 || head.truncated) throw new AppError('internal', 'git_failed');
  digest.update(JSON.stringify([root, configuration, head.code === 0 ? head.stdout.trim() : null]));
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
      const stat = await fs.lstat(file);
      digest.update(JSON.stringify(stat.isDirectory()
        ? [relative, stat.mode, stat.ino, stat.dev]
        : [relative, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]));
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(file);
        if ((target !== root && !isInside(root, target)) || path.relative(root, target).split(path.sep).includes('.git')) throw new AppError('bad_request');
        digest.update(JSON.stringify(['link', await fs.readlink(file)]));
      } else if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          const resolved = await fs.realpath(file);
          if (!isInside(root, resolved)) throw new AppError('bad_request');
          const currentPath = await fs.stat(resolved);
          if (before.dev !== currentPath.dev || before.ino !== currentPath.ino) throw new AppError('conflict');
          if (before.dev !== stat.dev || before.ino !== stat.ino) throw new AppError('conflict');
          for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AppError('conflict');
          digest.update('\0');
        } finally { await handle.close(); }
      } else throw new AppError('bad_request');
    }
  }
  await visit(root);
  return digest.digest('hex');
}
