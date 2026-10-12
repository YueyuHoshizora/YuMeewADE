// 三平台 CI：僅啟動安裝／解包後的 binary；每個產物使用獨立工作區、profile 與 HOME。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { Task, TerminalLease, TerminalSession } from '../src/shared/types.ts';
import { seedUpgradeFixture, assertUpgradeFixture } from '../src/testing/upgrade-fixture.ts';

export function artifactKind(name: string, platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return name.endsWith('.dmg') ? 'dmg' : name.endsWith('.zip') ? 'zip' : null;
  if (platform === 'linux') return name.endsWith('.deb') ? 'deb' : name.endsWith('.AppImage') ? 'AppImage' : null;
  if (platform === 'win32' && name.endsWith('.exe')) return /setup/i.test(name) ? 'nsis' : 'portable';
  return null;
}

function command(binary: string, args: string[], cwd?: string): string {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout;
}

function keychainPreferences(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(['default-keychain', 'list-keychains'].map(operation => {
    const result = spawnSync('/usr/bin/security', [operation, '-d', 'user'], { env, encoding: 'utf8', timeout: 15_000 });
    if (result.error) throw result.error;
    if (result.status !== 0 && !(operation === 'default-keychain' && result.status === 1
      && result.stderr.includes('A default keychain could not be found'))) throw new Error(`Could not inspect ${operation}`);
    return { status: result.status, stdout: result.stdout };
  }));
}

async function prepareMacKeychain(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Security's user preference domain is HOME-scoped; never mutate the real user's keychains.
  if (env['HOME'] !== home) throw new Error('Private keychain HOME mismatch');
  const existing = spawnSync('/usr/bin/security', ['default-keychain', '-d', 'user'],
    { env, encoding: 'utf8', timeout: 15_000 });
  if (existing.error) throw existing.error;
  if (existing.status !== 1 || !existing.stderr.includes('A default keychain could not be found')) {
    throw new Error('Private HOME unexpectedly has a default keychain');
  }
  const directory = path.join(home, 'Library', 'Keychains');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // security setters report success but cannot persist preferences unless this directory exists.
  await mkdir(path.join(home, 'Library', 'Preferences'), { recursive: true, mode: 0o700 });
  // Keep the synthetic identity distinct from the user's login keychain.
  const keychain = path.join(directory, 'artifact-smoke.keychain-db');
  const password = randomBytes(32).toString('hex');
  for (const args of [
    ['create-keychain', '-p', password, keychain],
    ['default-keychain', '-d', 'user', '-s', keychain],
    ['list-keychains', '-d', 'user', '-s', keychain],
    ['unlock-keychain', '-p', password, keychain],
  ]) {
    const result = spawnSync('/usr/bin/security', args, { env, encoding: 'utf8', timeout: 15_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Private ${args[0]} failed (${result.status ?? result.signal}): ${result.stderr.replaceAll(password, '[redacted]')}`);
  }
  const configured = spawnSync('/usr/bin/security', ['default-keychain', '-d', 'user'],
    { env, encoding: 'utf8', timeout: 15_000 });
  if (configured.error) throw configured.error;
  if (configured.status !== 0 || !configured.stdout.includes(path.basename(keychain))) {
    throw new Error('Private keychain preferences did not persist');
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(new Error('No loopback port')); return; }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
  return promise;
}

async function uniqueFile(root: string, predicate: (name: string) => boolean): Promise<string> {
  const files = (await readdir(root, { recursive: true })).filter(predicate);
  if (files.length !== 1) throw new Error(`Expected one executable in ${root}, found ${files.length}`);
  return path.join(root, files[0]!);
}

async function unpack(artifact: string, kind: string, root: string): Promise<string> {
  const destination = path.join(root, 'installed');
  await mkdir(destination);
  if (kind === 'dmg') {
    const mount = path.join(root, 'mount');
    await mkdir(mount);
    command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact]);
    try {
      const apps = (await readdir(mount)).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw new Error('DMG must contain one app');
      command('ditto', [path.join(mount, apps[0]!), path.join(destination, apps[0]!)]);
    } finally { command('hdiutil', ['detach', mount]); }
  } else if (kind === 'zip') command('ditto', ['-x', '-k', artifact, destination]);
  else if (kind === 'deb') command('dpkg-deb', ['-x', artifact, destination]);
  else if (kind === 'AppImage') {
    await chmod(artifact, 0o755);
    command(artifact, ['--appimage-extract'], destination);
    return path.join(destination, 'squashfs-root', 'AppRun');
  } else if (kind === 'nsis') {
    // NSIS 的 /D 必須是最後一個參數，且不加內嵌引號。
    command(artifact, ['/S', '/currentuser', `/D=${destination}`]);
    return uniqueFile(destination, name => path.basename(name) === 'YuMeewADE.exe');
  } else {
    const executable = path.join(destination, path.basename(artifact));
    await cp(artifact, executable);
    return executable;
  }
  if (process.platform === 'darwin') return uniqueFile(destination, name => name.endsWith('.app/Contents/MacOS/YuMeewADE'));
  return uniqueFile(destination, name => path.basename(name) === 'yumeewade');
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000 });
    if (result.error) throw result.error;
    // Portable launcher 可能已退出；另以隔離目錄中的真實桌面 PID 清理。
    if (result.status !== 0 && child.exitCode === null) throw new Error('Could not terminate artifact process tree');
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 1500); await promise;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

async function desktopPid(directory: string): Promise<number | undefined> {
  try {
    const report: unknown = JSON.parse(await readFile(path.join(directory, 'process.json'), 'utf8'));
    if (report && typeof report === 'object' && 'pid' in report && typeof report.pid === 'number'
      && Number.isSafeInteger(report.pid) && report.pid > 0) return report.pid;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
}

async function smoke(artifact: string, kind: string, expectedVersion: string): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'yumeewade-artifact-'));
  let child: ChildProcess | undefined;
  let keyring: ChildProcess | undefined;
  const originalKeychains = process.platform === 'darwin' ? keychainPreferences(process.env) : undefined;
  try {
    const binary = await unpack(artifact, kind, temporary);
    const home = path.join(temporary, 'home');
    const workspace = path.join(temporary, 'workspace');
    await mkdir(home); await mkdir(workspace);
    const retained = await seedUpgradeFixture(workspace);
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = path.join(temporary, 'config.yaml');
    await writeFile(config, `server:\n  host: 127.0.0.1\n  port: ${port}\nworkspace:\n  root: ${JSON.stringify(workspace)}\nupdate:\n  enabled: false\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
      YUMEEWADE_CONFIG: config, YUMEEWADE_ARTIFACT_SMOKE: temporary };
    // 不繼承 API keys、CLI credential home、Node/Electron 注入旗標或真實使用者設定。
    const inherited: Record<string, true> = { PATH: true, SYSTEMROOT: true, WINDIR: true, COMSPEC: true,
      PATHEXT: true, LANG: true, LC_ALL: true, DISPLAY: true, XAUTHORITY: true, DBUS_SESSION_BUS_ADDRESS: true };
    for (const [name, value] of Object.entries(process.env)) if (inherited[name.toUpperCase()]) env[name] = value;
    env['TMPDIR'] = temporary; env['TEMP'] = temporary; env['TMP'] = temporary;
    await mkdir(env['APPDATA']!, { recursive: true }); await mkdir(env['LOCALAPPDATA']!, { recursive: true });
    if (process.platform === 'darwin') await prepareMacKeychain(home, env);
    if (process.platform === 'linux') {
      if (process.env['YUMEEWADE_SMOKE_PRIVATE_DBUS'] !== '1' || !env['DBUS_SESSION_BUS_ADDRESS']) throw new Error('Linux smoke requires a private D-Bus session');
      env['XDG_RUNTIME_DIR'] = path.join(temporary, 'runtime');
      env['XDG_CURRENT_DESKTOP'] = 'GNOME';
      delete env['GNOME_KEYRING_CONTROL']; delete env['SSH_AUTH_SOCK'];
      await mkdir(env['XDG_RUNTIME_DIR'], { mode: 0o700 });
      const control = path.join(temporary, 'keyring');
      await mkdir(control, { mode: 0o700 });
      keyring = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', `--control-directory=${control}`],
        { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      let keyringError: Error | undefined;
      keyring.on('error', error => { keyringError = error; });
      keyring.stdin?.on('error', error => { keyringError = error; });
      keyring.stdin?.end(randomBytes(32).toString('hex'));
      const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 1000); await promise;
      if (keyringError) throw keyringError;
      if (keyring.exitCode !== null || keyring.signalCode !== null) throw new Error('Isolated encrypted keyring failed to start');
    }
    child = spawn(binary, process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [], { cwd: home, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError: Error | undefined;
    let logs = '';
    child.on('error', error => { launchError = error; });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data: Buffer) => { logs = (logs + data.toString()).slice(-16000); });
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        const pid = process.platform === 'win32' ? await desktopPid(temporary) : undefined;
        if (!pid) throw new Error(`Artifact exited before ready: ${logs}`);
        try { process.kill(pid, 0); } catch { throw new Error(`Packaged desktop exited: ${logs}`); }
      }
      try {
        const response = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(1500) });
        const ping: unknown = await response.json();
        if (!response.ok || !ping || typeof ping !== 'object' || !('app' in ping) || ping.app !== 'yumeewade'
          || !('ok' in ping) || ping.ok !== true || !('version' in ping) || ping.version !== expectedVersion) throw new Error('Core identity/version mismatch');
        const renderer: unknown = JSON.parse(await readFile(path.join(temporary, 'renderer.json'), 'utf8'));
        if (!renderer || typeof renderer !== 'object' || !('origin' in renderer) || renderer.origin !== origin
          || !('rendered' in renderer) || renderer.rendered !== true || !('preload' in renderer) || renderer.preload !== true) throw new Error('Renderer handshake mismatch');
        ready = true; break;
      } catch { /* 啟動中尚無 API 或 renderer 握手；總期限到即失敗。 */ }
      const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 200); await promise;
    }
    if (!ready) throw new Error(`Artifact core/renderer timeout: ${logs}`);
    const htmlResponse = await fetch(origin, { signal: AbortSignal.timeout(5000) });
    if (!htmlResponse.ok || !htmlResponse.headers.get('content-type')?.includes('text/html')) throw new Error('UI entry unavailable');
    const html = await htmlResponse.text();
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(match => match[1]!);
    if (!assets.some(asset => asset.includes('.js')) || !assets.some(asset => asset.includes('.css'))) throw new Error('Packaged UI assets missing');
    for (const asset of assets) {
      const url = new URL(asset, origin);
      if (url.origin !== origin) throw new Error('UI asset escapes loopback origin');
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.text()).length || response.headers.get('content-type')?.includes('text/html')) throw new Error(`UI asset unavailable: ${asset}`);
    }
    const state = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5000) });
    const stateValue = await state.json() as { projects?: { id: string; tasks?: { id: string; title: string; steps?: { done: boolean }[] }[] }[] };
    const retainedProject = stateValue.projects?.find(project => project.id === 'UpgradeRetained');
    const retainedTask = retainedProject?.tasks?.find(task => task.id === '20261011-001');
    if (!retainedTask || retainedTask.title !== 'Retained legacy task' || retainedTask.steps?.[0]?.done !== true) throw new Error('Legacy ledger upgrade lost project/task data');
    await assertUpgradeFixture(workspace, retained);
    if (!state.ok) throw new Error('Public application state unavailable');
    const post = async <T>(route: string, body: Record<string, unknown>): Promise<T> => {
      const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        const message = await response.text();
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        const localLog = await readFile(path.join(workspace, '.yumeewade', 'yumeewade.log'), 'utf8').catch(() => '');
        throw new Error(`Packaged ${route} failed (${response.status}): ${message}\n${logs}\n${localLog.slice(-16000)}`);
      }
      return await response.json() as T;
    };
    await post('/api/project/new', { name: 'ArtifactPTY' });
    const task = await post<Task>('/api/task/new', { project: 'ArtifactPTY', title: 'Native terminal smoke', workspace: 'direct' });
    const ids = { project: 'ArtifactPTY', task: task.id };
    const lease = await post<TerminalLease>('/api/terminal/start', { ...ids, command: process.execPath,
      args: ['-e', 'console.log("NATIVE_TTY",process.stdin.isTTY,process.stdout.isTTY);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",()=>{console.log("NATIVE_INPUT");process.exit(0)})'], cols: 80, rows: 24 });
    const capability = { ...ids, id: lease.session.id, owner: lease.owner };
    try {
      const waitOutput = async (marker: string): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const current = await post<TerminalSession>('/api/terminal/output', capability);
          if (stripVTControlCharacters(current.output.map(item => item.text).join('')).includes(marker)) return;
          if (current.status !== 'running') throw new Error(`Packaged PTY exited without ${marker}`);
          await new Promise<void>(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Packaged PTY did not emit ${marker}`);
      };
      await waitOutput('NATIVE_TTY true true');
      await post('/api/terminal/resize', { ...capability, cols: 92, rows: 31 });
      await post('/api/terminal/input', { ...capability, text: 'q' });
      await waitOutput('NATIVE_INPUT');
    } finally {
      await post('/api/terminal/stop', capability);
    }
    console.log(`PASS ${kind} ${path.basename(artifact)} — packaged binary, loopback API ${expectedVersion}, rendered UI/preload, ${assets.length} assets, native PTY TTY/input/resize`);
  } finally {
    try {
      if (process.platform === 'win32') {
        const pid = await desktopPid(temporary);
        if (pid && pid !== child?.pid) {
          const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000 });
          if (result.error) throw result.error;
          if (result.status !== 0) {
            let alive = false;
            try { process.kill(pid, 0); alive = true; } catch { /* 已正常退出。 */ }
            if (alive) throw new Error('Could not terminate packaged desktop process tree');
          }
        }
      }
      if (child) await terminate(child);
    }
    finally {
      try { if (keyring) await terminate(keyring); }
      finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        if (originalKeychains !== undefined && keychainPreferences(process.env) !== originalKeychains) {
          throw new Error('Real user keychain preferences changed during artifact smoke');
        }
      }
    }
  }
}

export async function smokeArtifacts(directory: string): Promise<void> {
  const expected = process.platform === 'darwin' ? ['dmg', 'zip'] : process.platform === 'win32' ? ['nsis', 'portable'] : process.platform === 'linux' ? ['deb', 'AppImage'] : [];
  if (!expected.length) throw new Error('Unsupported artifact smoke platform');
  const metadata: unknown = JSON.parse(await readFile('package.json', 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('Invalid package version');
  const version = metadata.version;
  const artifacts = (await readdir(directory)).map(name => ({ name, kind: artifactKind(name, process.platform) })).filter(entry => entry.kind !== null);
  for (const kind of expected) {
    const entries = artifacts.filter(entry => entry.kind === kind);
    if (entries.length !== 1) throw new Error(`Expected exactly one ${kind} artifact, found ${entries.length}`);
    await smoke(path.resolve(directory, entries[0]!.name), kind, version);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform === 'linux' && process.env['YUMEEWADE_SMOKE_PRIVATE_DBUS'] !== '1') {
    const result = spawnSync('dbus-run-session', ['--', process.execPath, ...process.argv.slice(1)],
      { env: { ...process.env, YUMEEWADE_SMOKE_PRIVATE_DBUS: '1' }, stdio: 'inherit', timeout: 600_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Linux artifact smoke failed (${result.status ?? result.signal})`);
  } else await smokeArtifacts(process.argv[2] ?? 'release');
}
