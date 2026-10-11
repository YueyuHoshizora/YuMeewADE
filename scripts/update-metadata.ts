import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestPayload, UPDATE_METADATA, type IntegrityManifest } from '../src/system/update-download.ts';

const root = process.argv[2] ?? 'artifacts';
const version = process.env['GITHUB_REF_NAME']?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable version tag required');
const manifest: IntegrityManifest = { version, assets: [] };
for (const name of (await readdir(root)).sort()) {
  if (!/\.(?:dmg|zip|exe|AppImage|deb)$/.test(name)) continue;
  const file = path.join(root, name); const info = await stat(file);
  if (!info.isFile()) throw new Error('Artifact must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  manifest.assets.push({ name, size: info.size, sha256: hash.digest('hex') });
}
if (!manifest.assets.length) throw new Error('No artifacts');
const privateKey = process.env['UPDATE_SIGNING_PRIVATE_KEY'];
if (privateKey) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
  manifest.signature = sign(null, Buffer.from(manifestPayload(manifest)), key).toString('base64');
} else console.log('No publisher signing key supplied: checksum metadata is integrity-only, not publisher trust.');
await writeFile(path.join(root, UPDATE_METADATA), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
