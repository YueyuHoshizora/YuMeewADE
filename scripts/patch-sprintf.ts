// Local security patch for GHSA-hp3w-g68c-fv3c; upstream version/license remain unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SPRINTF_SOURCE_SHA256 = '95add43f116385be221745307fae02d06751b01d4f939df1debb17dbe2ebf4eb';
const ANCHOR = "            else if ((match = re.placeholder.exec(_fmt)) !== null) {\n";
const PATCH = "                // YuMeewADE: reject invalid numeric precision before formatting or argument evaluation.\n" +
  "                if (match[7] !== undefined && /^[efg]$/.test(match[8])) {\n" +
  "                    var precision = Number(match[7])\n" +
  "                    if (!Number.isInteger(precision) || precision > 100 || precision < (match[8] === 'g' ? 1 : 0)) {\n" +
  "                        throw new SyntaxError('[sprintf] numeric precision outside supported range')\n" +
  "                    }\n" +
  "                }\n";

/** Exact-source gate makes installation reproducible and detects drift rather than guessing a new patch. */
export function patchSprintfSource(source: string): string {
  const original = source.includes(PATCH) ? source.replace(PATCH, '') : source;
  if (createHash('sha256').update(original).digest('hex') !== SPRINTF_SOURCE_SHA256) throw new Error('sprintf-js source changed: review GHSA-hp3w-g68c-fv3c patch against the pinned 1.1.3 source; do not bypass the hash check.');
  const patched = original.replace(ANCHOR, ANCHOR + PATCH);
  if (patched === original || (source !== original && source !== patched)) throw new Error('Unexpected sprintf-js patch state; reinstall pinned dependencies and review the security patch.');
  return patched;
}

export async function patchInstalledSprintf(): Promise<void> {
  const require = createRequire(import.meta.url);
  const filename = require.resolve('sprintf-js');
  const root = path.dirname(path.dirname(filename));
  const metadata: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== '1.1.3' || !('main' in metadata) || metadata.main !== 'src/sprintf.js') throw new Error('Security patch requires exact sprintf-js 1.1.3 src/sprintf.js; review dependency changes first.');
  const source = await readFile(filename, 'utf8');
  const patched = patchSprintfSource(source);
  if (patched === source) return;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, patched, { flag: 'wx', mode: 0o644 });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
  console.log('Applied local sprintf-js 1.1.3 precision validation patch (upstream advisory remains unpatched).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await patchInstalledSprintf();
