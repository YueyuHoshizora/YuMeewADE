import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MockCliProvider } from '../cli/mock.ts';
import { OpLog } from '../ledger/oplog.ts';
import { parseConfig } from '../shared/config.ts';
import type { AppState, Project, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { CoreHost } from './host.ts';
import { App } from './app.ts';
import { withFileLocks } from '../shared/fsx.ts';

test('切換工作區：新根目錄立即生效並寫回設定檔，舊資料留在原處', async () => {
  const s = await startTestServer();
  try {
    const before = s.app.ws.root;
    await s.api('POST', '/api/project/new', { name: 'Old' });
    await new Promise(resolve => setTimeout(resolve, 250)); // 建立專案的 changed 先送完，下面才不會誤判
    // 切換前就開著的即時連線：切換後不能被關掉，而且要收到 changed
    const events = new AbortController();
    const reader = (await fetch(`${s.base}/api/events`, { signal: events.signal })).body!.getReader();
    const decoder = new TextDecoder(); let received = '';
    const until = async (pattern: RegExp) => { while (!pattern.test(received)) { const chunk = await reader.read(); assert.ok(!chunk.done, '連線被關閉'); received += decoder.decode(chunk.value); } };
    await until(/event: ready/u);
    received = '';
    const next = path.join(s.dir, 'other root');
    const res = await s.api('POST', '/api/workspace', { root: next });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { root: next });
    await until(/event: changed/u);
    events.abort();
    const state = (await s.api('GET', '/api/state')).json as AppState;
    assert.equal(state.root, next);
    assert.deepEqual(state.projects, []);
    assert.equal((await s.api('POST', '/api/project/new', { name: 'New' })).status, 200);
    await fs.access(path.join(next, 'Projects', 'New', 'PROJECT.md'));
    await fs.access(path.join(before, 'Projects', 'Old', 'PROJECT.md'));
    const saved = await fs.readFile(s.configFile, 'utf8');
    assert.equal(parseConfig(saved, s.configFile).workspace.root, next);
    assert.match(saved, /^server:\n  port: \d+\n/u);
    // 切回原本的工作區，原有專案仍在
    assert.equal((await s.api('POST', '/api/workspace', { root: before })).status, 200);
    assert.deepEqual(((await s.api('GET', '/api/state')).json as AppState).projects.map(p => p.id), ['Old']);
  } finally { await s.close(); }
});

test('切換工作區：拒絕相對路徑、檔案路徑與 AI 執行中，失敗時維持原工作區與設定檔', async () => {
  const s = await startTestServer('', { providers: { mock: new MockCliProvider({ chunkMs: 100, text: 'done' }) } });
  try {
    const root = s.app.ws.root;
    const config = await fs.readFile(s.configFile, 'utf8');
    const relative = await s.api('POST', '/api/workspace', { root: 'relative/ws' });
    assert.equal(relative.status, 400);
    assert.equal((relative.json as { detail: string }).detail, 'root_not_absolute');
    const file = path.join(s.dir, 'plain-file');
    await fs.writeFile(file, 'x');
    assert.equal(((await s.api('POST', '/api/workspace', { root: file })).json as { detail: string }).detail, 'root_not_directory');
    const p = (await s.api('POST', '/api/project/new', { name: 'Busy' })).json as Project;
    const t = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Work', cli: 'mock', workspace: 'direct' })).json as Task;
    await s.app.runner.send({ project: p.id, task: t.id, ai: 'mock', text: 'Run' });
    const busy = await s.api('POST', '/api/workspace', { root: path.join(s.dir, 'elsewhere') });
    assert.equal(busy.status, 409);
    assert.equal((busy.json as { detail: string }).detail, 'relocate_busy');
    await s.app.runner.whenIdle();
    assert.equal(s.app.ws.root, root);
    assert.equal(await fs.readFile(s.configFile, 'utf8'), config);
    await assert.rejects(fs.access(path.join(s.dir, 'elsewhere')));
  } finally { await s.close(); }
});

test('core startup refuses a second owner and shutdown releases workspace ownership', () => withTmpWorkspace(async ws => {
  const config = parseConfig(`workspace:\n  root: ${JSON.stringify(ws.root)}\n`, null);
  const first = new CoreHost(config, { app: { providers: { mock: new MockCliProvider() } } });
  const second = new CoreHost(config, { app: { providers: { mock: new MockCliProvider() } } });
  try {
    await first.init();
    await assert.rejects(second.init(), /已有核心程序/);
    await first.shutdown();
    await second.init();
    assert.equal(JSON.parse(await fs.readFile(path.join(ws.root, '.yumeewade', 'core.lock'), 'utf8')).pid, process.pid);
    await second.shutdown();
    await assert.rejects(fs.access(path.join(ws.root, '.yumeewade', 'core.lock')));
  } finally {
    first.close();
    second.close();
  }
}));

test('core init failure closes resources already opened and releases workspace ownership', () => withTmpWorkspace(async ws => {
  const config = parseConfig(`workspace:\n  root: ${JSON.stringify(ws.root)}\n`, null);
  const host = new CoreHost(config, { app: { providers: { mock: new MockCliProvider() } } });
  // care starts after the preview gateway is already listening.
  host.app.care.init = async () => { throw new Error('care init failed'); };
  try {
    await assert.rejects(host.init(), /care init failed/u);
    const gateway = host.app.embeddedPreview.gatewayOrigin();
    assert.match(gateway, /^http:\/\/127\.0\.0\.1:\d+$/u);
    await assert.rejects(fetch(gateway), 'preview gateway must stop listening after a failed init');
    await assert.rejects(fs.access(path.join(ws.root, '.yumeewade', 'core.lock')));
  } finally { host.close(); }
}));

test('切換工作區：換上新工作區後紀錄寫入失敗仍回報成功並收尾舊工作區', async () => {
  const s = await startTestServer();
  const record = OpLog.prototype.record;
  try {
    const before = s.app.ws.root;
    await fs.access(path.join(before, '.yumeewade', 'core.lock'));
    OpLog.prototype.record = async function (this: OpLog, entry) {
      if (entry.action === 'workspace') throw new Error('oplog disk full');
      return record.call(this, entry);
    };
    const next = path.join(s.dir, 'next root');
    const res = await s.api('POST', '/api/workspace', { root: next });
    assert.equal(res.status, 200);
    assert.equal(s.app.ws.root, next);
    await assert.rejects(fs.access(path.join(before, '.yumeewade', 'core.lock')), 'old workspace ownership must be released');
    await fs.access(path.join(next, '.yumeewade', 'core.lock'));
  } finally {
    OpLog.prototype.record = record;
    await s.close();
  }
});

test('an admitted language request cannot start an old workspace LSP after switching', { timeout: 10000 }, async () => {
  const s = await startTestServer();
  const old = s.app;
  const release = Promise.withResolvers<void>();
  const locked = Promise.withResolvers<void>();
  let held: Promise<unknown> | undefined;
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const file = path.join(old.ws.projectDir('P'), 'a.ts');
    const marker = path.join(s.dir, 'lsp-started');
    await fs.writeFile(file, 'const a = 1;');
    old.editor.commands.typescript = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){let e=b.indexOf('\\r\\n\\r\\n');if(e<0)return;let n=Number(/Content-Length:\\s*(\\d+)/i.exec(b.subarray(0,e).toString())[1]);if(b.length<e+4+n)return;let m=JSON.parse(b.subarray(e+4,e+4+n));b=b.subarray(e+4+n);if(m.id!==undefined){let x=JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{capabilities:{}}:null});process.stdout.write('Content-Length: '+Buffer.byteLength(x)+'\\r\\n\\r\\n'+x);}}});`];
    held = withFileLocks([await fs.realpath(file)], async () => { locked.resolve(); await release.promise; });
    await locked.promise;
    const entered = Promise.withResolvers<void>();
    const language = old.editor.language.bind(old.editor);
    old.editor.language = (...args) => { entered.resolve(); return language(...args); };
    const pending = s.api('POST', '/api/editor/language', { project: 'P', path: 'a.ts', text: 'const a = 1;', line: 0, character: 0, action: 'hover' });
    await entered.promise;
    assert.equal((await s.api('POST', '/api/workspace', { root: path.join(s.dir, 'next') })).status, 200);
    release.resolve(); await held;
    const result = await pending;
    assert.equal(result.status, 503);
    assert.ok(result.json && typeof result.json === 'object' && 'detail' in result.json);
    assert.equal(result.json.detail, 'editor_language_unavailable');
    await assert.rejects(fs.access(marker), 'a closed editor must not spawn a language process');
  } finally { release.resolve(); await held; old.editor.dispose(); await s.close(); }
});

test('shutdown waits for pending relocation and prevents its App from being installed', { timeout: 10000 }, () => withTmpWorkspace(async (ws, dir) => {
  const configFile = path.join(dir, 'config.yaml');
  const text = `workspace:\n  root: ${JSON.stringify(ws.root)}\nupdate:\n  enabled: false\n`;
  await fs.writeFile(configFile, text);
  const host = new CoreHost(parseConfig(text, configFile), { app: { providers: { mock: new MockCliProvider() }, home: path.join(dir, 'home') } });
  await host.init();
  const old = host.app;
  const root = path.join(dir, 'next');
  const init = App.prototype.init;
  const initialized = Promise.withResolvers<App>();
  const resume = Promise.withResolvers<void>();
  let relocating: Promise<string> | undefined;
  let stopped: Promise<void> | undefined;
  try {
    App.prototype.init = async function () {
      await init.call(this);
      if (this.ws.root === root) { initialized.resolve(this); await resume.promise; }
    };
    relocating = host.relocate(root);
    const next = await initialized.promise;
    const outcome = relocating.then(() => 'committed', () => 'cancelled');
    let returned = false;
    stopped = host.shutdown().then(() => { returned = true; });
    const tick = Promise.withResolvers<void>();
    setImmediate(tick.resolve); await tick.promise;
    assert.equal(returned, false, 'shutdown must await pending relocation cleanup');
    resume.resolve();
    assert.equal(await outcome, 'cancelled');
    await stopped;
    assert.equal(host.app, old);
    await assert.rejects(fs.access(path.join(root, '.yumeewade', 'core.lock')));
    await assert.rejects(fs.access(path.join(old.ws.root, '.yumeewade', 'core.lock')));
    await assert.rejects(fetch(next.embeddedPreview.gatewayOrigin()));
    await assert.rejects(host.relocate(root), { code: 'unavailable' });
  } finally {
    resume.resolve(); App.prototype.init = init;
    await relocating?.catch(() => undefined); await stopped;
    await host.shutdown(); host.close();
  }
}));
