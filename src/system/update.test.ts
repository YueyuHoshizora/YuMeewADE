import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpdateWatcher, compareVersions, fetchLatestRelease, pickAssets } from './update.ts';
import type { UpdateInfo } from '../shared/types.ts';

const REPO = 'YueyuHoshizora/YuMeewADE';
const dl = (name: string) => ({ name, browser_download_url: `https://github.com/${REPO}/releases/download/v1.2.0/${name}`, size: 10 });
const release = (patch: Record<string, unknown> = {}) => ({
  tag_name: 'v1.2.0', html_url: `https://github.com/${REPO}/releases/tag/v1.2.0`, body: 'notes', draft: false, prerelease: false,
  assets: ['YuMeewADE-1.2.0-arm64.dmg', 'YuMeewADE-1.2.0-arm64-mac.zip', 'YuMeewADE.Setup.1.2.0.exe', 'YuMeewADE.1.2.0.exe', 'YuMeewADE-1.2.0.AppImage', 'yumeewade_1.2.0_amd64.deb'].map(dl),
  ...patch,
});
const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('compareVersions orders numerically and treats prereleases as lower', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.0.1', '1.0.0') > 0);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0);
  assert.ok(compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.ok(Number.isNaN(compareVersions('latest', '1.0.0')));
});

test('pickAssets keeps only this platform and architecture, installer first', () => {
  const raw = release().assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  assert.deepEqual(pickAssets(raw, 'darwin', 'arm64').map(a => [a.kind, a.name]), [['installer', 'YuMeewADE-1.2.0-arm64.dmg'], ['portable', 'YuMeewADE-1.2.0-arm64-mac.zip']]);
  assert.deepEqual(pickAssets(raw, 'darwin', 'x64'), []);
  assert.deepEqual(pickAssets(raw, 'win32', 'x64').map(a => [a.kind, a.name]), [['installer', 'YuMeewADE.Setup.1.2.0.exe'], ['portable', 'YuMeewADE.1.2.0.exe']]);
  assert.deepEqual(pickAssets(raw, 'linux', 'x64').map(a => [a.kind, a.name]), [['installer', 'yumeewade_1.2.0_amd64.deb'], ['portable', 'YuMeewADE-1.2.0.AppImage']]);
});

test('fetchLatestRelease parses a release and rejects unusable or foreign ones', async () => {
  const ok = await fetchLatestRelease(REPO, 'win32', 'x64', reply(release()));
  assert.equal(ok?.version, '1.2.0');
  assert.equal(ok?.assets.length, 2);
  assert.equal(await fetchLatestRelease(REPO, 'win32', 'x64', reply(release(), 403)), null);
  assert.equal(await fetchLatestRelease(REPO, 'win32', 'x64', reply(release({ prerelease: true }))), null);
  assert.equal(await fetchLatestRelease(REPO, 'win32', 'x64', reply(release({ tag_name: 'nightly' }))), null);
  assert.equal(await fetchLatestRelease(REPO, 'win32', 'x64', reply(release({ html_url: 'https://evil.example/x' }))), null);
  const foreign = release({ assets: [{ name: 'YuMeewADE.Setup.1.2.0.exe', browser_download_url: 'https://evil.example/a.exe', size: 1 }] });
  assert.deepEqual((await fetchLatestRelease(REPO, 'win32', 'x64', reply(foreign)))?.assets, []);
  assert.equal(await fetchLatestRelease(REPO, 'win32', 'x64', (async () => { throw new Error('offline'); }) as typeof fetch), null);
});

test('UpdateWatcher only surfaces newer releases and keeps the last result on failure', async () => {
  const info = (version: string): UpdateInfo => ({ version, tag: version, url: 'u', notes: '', assets: [] });
  const results: (UpdateInfo | null)[] = [info('1.0.0'), info('1.0.1'), null, info('1.0.1')];
  let changes = 0;
  const watcher = new UpdateWatcher('1.0.0', async () => results.shift() ?? null, () => { changes++; });
  await watcher.poll(3_600_000);
  assert.equal(watcher.snapshot(), undefined);
  assert.equal(changes, 0);
  await watcher.poll(3_600_000);
  assert.equal(watcher.snapshot()?.version, '1.0.1');
  assert.equal(changes, 1);
  await watcher.poll(3_600_000);
  assert.equal(watcher.snapshot()?.version, '1.0.1');
  await watcher.poll(3_600_000);
  assert.equal(changes, 1);
  watcher.close();
});
