import { constants, promises as fs } from 'node:fs';

/** Bound even a file growing during import, and never follow a credential-file symlink. */
export async function readCredentialFile(file: string): Promise<string> {
  const max = 1024 * 1024;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('Account credentials unavailable.');
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > max) throw new Error('Account credentials unavailable.');
    return buffer.toString('utf8', 0, size);
  } finally { await handle.close(); }
}
