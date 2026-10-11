import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MockCliProvider } from '../cli/mock.ts';
import { parseConfig } from '../shared/config.ts';
import type { AppState, Project, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { CoreHost } from './host.ts';

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
