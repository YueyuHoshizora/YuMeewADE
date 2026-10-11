// CI 專用：只發佈打包產物，版本說明優先使用對應的 CHANGELOG 區段。
import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function releaseNotes(changelog: string, tag: string): string | null {
  const version = tag.replace(/^v/, '');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[([^\]]+)\]/.exec(line)?.[1] === version);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim() || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tag = process.env['GITHUB_REF_NAME'];
  if (!tag?.startsWith('v')) throw new Error('Release requires a v* tag');
  const root = 'artifacts';
  const files = (await readdir(root, { recursive: true })).filter((file) => /\.(?:dmg|zip|exe|AppImage|deb)$/.test(file) || file === 'update-integrity.json').sort().map((file) => path.join(root, file));
  if (!files.length) throw new Error('No release artifacts downloaded');
  const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), tag);
  const temporary = await mkdtemp(path.join(tmpdir(), 'yumeewade-release-'));
  try {
    const args = ['release', 'create', tag, ...files, '--title', `YuMeewADE ${tag}`];
    if (notes) {
      const notesFile = path.join(temporary, 'notes.md');
      await writeFile(notesFile, notes, 'utf8');
      args.push('--notes-file', notesFile);
    } else args.push('--generate-notes');
    const result = spawnSync('gh', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`gh release create exited with ${result.status ?? result.signal}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
