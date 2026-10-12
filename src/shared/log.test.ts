import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_TAIL_BYTES, LOG_TAIL_LINES, readLogTail, redactLog } from './log.ts';

test('redacts home paths, JSON credentials, bearer tokens, JWT and opaque tokens', () => {
  const secret = 'a'.repeat(40);
  const text = redactLog(`/Users/alice/work {"access_token":"short","password":"p\\\"q"} Bearer short-token sk-abc ghp_abc eyJabc.def.xyz ${secret} token=short`, '/Users/alice');
  assert.ok(text.includes('~/work'));
  for (const value of ['/Users/alice', 'short', 'sk-abc', 'ghp_abc', 'eyJabc.def.xyz', secret]) assert.ok(!text.includes(value), value);
  assert.ok(text.includes('[REDACTED]'));
  assert.equal(redactLog('message info warn error', ''), 'message info warn error');
  assert.equal(redactLog('C:\\\\Users\\\\alice\\\\work', 'C:\\Users\\alice'), '~\\\\work');
});

test('a redacted JSON log entry is still valid JSON with its level, so level filters keep it', () => {
  const line = JSON.stringify({ level: 'error', msg: 'request failed: token="abc" Bearer xyz', data: { password: 'p"q', nested: [{ apiKey: 'k' }] } });
  const entry = JSON.parse(redactLog(`${line}\n${line}`, '').split('\n')[1]!) as { level: string; msg: string; data: { password: string; nested: { apiKey: string }[] } };
  assert.equal(entry.level, 'error');
  assert.ok(!entry.msg.includes('abc') && !entry.msg.includes('xyz'), entry.msg);
  assert.equal(entry.data.password, '[REDACTED]'); assert.equal(entry.data.nested[0]!.apiKey, '[REDACTED]');
});

test('tail is capped by bytes and lines, skips partial records and handles missing files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'log-tail-'));
  try {
    assert.deepEqual(await readLogTail(root), { text: '', truncated: false });
    const dir = path.join(root, '.yumeewade'); await fs.mkdir(dir);
    const file = path.join(dir, 'yumeewade.log');
    await fs.writeFile(file, 'x'.repeat(LOG_TAIL_BYTES + 10) + '\n' + Array.from({ length: 1200 }, (_, n) => JSON.stringify({ level: 'info', msg: `line ${n}` })).join('\n') + '\n');
    const tail = await readLogTail(root);
    assert.equal(tail.truncated, true); assert.ok(Buffer.byteLength(tail.text) <= LOG_TAIL_BYTES);
    assert.equal(tail.text.split('\n').length, LOG_TAIL_LINES);
    assert.equal(JSON.parse(tail.text.split('\n')[0]!).msg, 'line 200');
    assert.equal(JSON.parse(tail.text.split('\n').at(-1)!).msg, 'line 1199');
    await fs.writeFile(file, 'z'.repeat(LOG_TAIL_BYTES + 1));
    assert.deepEqual(await readLogTail(root), { text: '', truncated: true });
    await fs.writeFile(file, '{"level":"warn","msg":"small"}\n');
    assert.deepEqual(await readLogTail(root), { text: '{"level":"warn","msg":"small"}', truncated: false });
    await fs.unlink(file); await fs.symlink(path.join(root, 'outside'), file); await fs.writeFile(path.join(root, 'outside'), 'private');
    assert.deepEqual(await readLogTail(root), { text: '', truncated: false });
    await fs.unlink(file); await fs.rmdir(dir); await fs.symlink(root, dir);
    assert.deepEqual(await readLogTail(root), { text: '', truncated: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
