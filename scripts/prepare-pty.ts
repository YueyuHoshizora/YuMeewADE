import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// node-pty 1.1.0 ships Darwin prebuilt spawn-helper without executable bits.
// Run during dependency/build/package preparation, before signing; never mutate an installed app.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const prebuilds = path.join(root, 'prebuilds');
  const platforms = await fs.readdir(prebuilds, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const folders = [path.join(root, 'build', 'Release'), path.join(root, 'build', 'Debug'), ...platforms.filter(entry => entry.isDirectory() && entry.name.startsWith('darwin-')).map(entry => path.join(prebuilds, entry.name))];
  let prepared = 0;
  for (const folder of folders) {
    const helper = path.join(folder, 'spawn-helper');
    const stat = await fs.lstat(helper).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('node-pty spawn-helper must be a regular file');
    await fs.chmod(helper, (stat.mode & 0o777) | 0o111);
    await fs.access(helper, constants.X_OK);
    prepared++;
  }
  if (!prepared) throw new Error('node-pty Darwin spawn-helper missing; dependency preparation failed');
}
