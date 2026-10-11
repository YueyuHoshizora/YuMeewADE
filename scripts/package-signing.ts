import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { patchInstalledSprintf } from './patch-sprintf.ts';
import './prepare-pty.ts';

await patchInstalledSprintf();

const args = [createRequire(import.meta.url).resolve('electron-builder/cli.js'), '--config', 'electron-builder.yml', '--publish', 'never'];
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
if (process.platform === 'darwin' && process.env['CSC_LINK']) {
  if (!process.env['CSC_KEY_PASSWORD'] || !process.env['CSC_NAME'] || !process.env['APPLE_ID'] || !process.env['APPLE_APP_SPECIFIC_PASSWORD'] || !process.env['APPLE_TEAM_ID']) throw new Error('Complete macOS signing and notarization secrets required');
  args.push(`--config.mac.identity=${process.env['CSC_NAME']}`, '--config.mac.hardenedRuntime=true', '--config.mac.notarize=true', '--config.mac.forceCodeSigning=true', '--config.dmg.sign=true');
} else if (process.platform === 'win32' && process.env['WIN_CSC_LINK']) {
  if (!process.env['WIN_CSC_KEY_PASSWORD']) throw new Error('Windows certificate password required');
  args.push('--config.win.signAndEditExecutable=true', '--config.win.forceCodeSigning=true');
} else console.log('No official platform signing credentials supplied: artifacts are not publisher-trusted.');
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Packaging failed');
