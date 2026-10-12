import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { patchInstalledSprintf } from './patch-sprintf.ts';
import './prepare-pty.ts';
import { signingPlan } from './signing-plan.ts';

await patchInstalledSprintf();

const args = [createRequire(import.meta.url).resolve('electron-builder/cli.js'), '--config', 'electron-builder.yml', '--publish', 'never'];
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const plan = signingPlan(process.platform, process.env);
args.push(...plan.args);
if (!plan.signed) console.log('No official platform signing credentials supplied: artifacts are not publisher-trusted.');
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Packaging failed');
