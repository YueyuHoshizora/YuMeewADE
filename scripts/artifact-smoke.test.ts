import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactKind, smokeArtifacts } from './artifact-smoke.ts';

test('artifact smoke covers installer and portable formats on all three platforms', () => {
  assert.equal(artifactKind('YuMeewADE-1.0.2-arm64.dmg', 'darwin'), 'dmg');
  assert.equal(artifactKind('YuMeewADE-1.0.2-arm64-mac.zip', 'darwin'), 'zip');
  assert.equal(artifactKind('YuMeewADE Setup 1.0.2.exe', 'win32'), 'nsis');
  assert.equal(artifactKind('YuMeewADE 1.0.2.exe', 'win32'), 'portable');
  assert.equal(artifactKind('yumeewade_1.0.2_amd64.deb', 'linux'), 'deb');
  assert.equal(artifactKind('YuMeewADE-1.0.2.AppImage', 'linux'), 'AppImage');
  assert.equal(artifactKind('builder-debug.yml', 'linux'), null);
  assert.equal(artifactKind('YuMeewADE.exe', 'darwin'), null);
});

test('missing packaged artifacts fail closed instead of starting source server', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yumeewade-artifact-test-'));
  try { await assert.rejects(smokeArtifacts(directory), /Expected exactly one|Unsupported artifact smoke platform/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
