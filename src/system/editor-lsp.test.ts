import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanguageClient } from './editor-lsp.ts';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { WorktreeService } from '../git/worktree.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { EditorService } from './editor.ts';

const server = String.raw`
let buffer = Buffer.alloc(0); const events = [];
const send = message => { const body = JSON.stringify({jsonrpc:'2.0', ...message}); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body); };
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); for (;;) {
const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString())[1]); if (buffer.length < end+4+length) return;
const message = JSON.parse(buffer.subarray(end+4,end+4+length)); buffer = buffer.subarray(end+4+length);
if (message.method === 'initialize') send({id:message.id,result:{capabilities:{}}});
else if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') {
 events.push(message); const doc = message.params.textDocument;
 const text = doc.text ?? message.params.contentChanges[0].text;
 setImmediate(() => {
 send({method:'textDocument/publishDiagnostics',params:{uri:doc.uri,version:doc.version,diagnostics:text.includes('bad')?[{message:text,range:{start:{line:0,character:0},end:{line:0,character:3}}}]:[]}});
 send({method:'textDocument/publishDiagnostics',params:{uri:doc.uri,version:doc.version-1,diagnostics:[{message:'stale'}]}});
 });
} else if (message.method === 'textDocument/didClose') events.push(message);
else if (message.method === 'events') send({id:message.id,result:events});
}});
`;

test('LSP unsaved sync versions, delayed push cache, stale rejection and close lifecycle', async () => {
  const client = new LanguageClient([process.execPath, '-e', server], process.cwd());
  const uri = 'file:///test.ts';
  try {
    await client.ready;
    client.openDocument(uri, 'typescript', 1, 'bad unsaved');
    assert.equal(((await client.publishedDiagnostics(uri)).items as { message: string }[])[0]?.message, 'bad unsaved');
    client.openDocument(uri, 'typescript', 2, 'fixed');
    assert.deepEqual(await client.publishedDiagnostics(uri), { items: [], truncated: false });
    client.closeDocument(uri);
    assert.equal(client.diagnostics.has(uri), false);
    client.openDocument(uri, 'typescript', 3, 'bad reopened');
    assert.equal(((await client.publishedDiagnostics(uri)).items as { message: string }[])[0]?.message, 'bad reopened');
    const events = await client.request('events', {}) as { method: string; params: { textDocument: { version: number }; contentChanges?: { text: string }[] } }[];
    assert.deepEqual(events.map(event => event.method), ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didOpen']);
    assert.equal(events[1]?.params.textDocument.version, 2);
    assert.equal(events[1]?.params.contentChanges?.[0]?.text, 'fixed');
  } finally { client.dispose(); }
});

const cappedServer = server.replace("text.includes('bad')?[{message:text,range:{start:{line:0,character:0},end:{line:0,character:3}}}]:[]", "Array.from({length:Number(text)}, (_, i) => ({message:'error '+i,range:{start:{line:0,character:0},end:{line:0,character:1}}}))")
  .replace("else if (message.method === 'events')", "else if (message.method === 'textDocument/diagnostic') send({id:message.id,error:{code:-32601,message:'unsupported'}});\nelse if (message.method === 'events')");

test('LSP oversized push diagnostics retain first 1000 and reset truncation on update and close', () => withTmpWorkspace(async ws => {
  const client = new LanguageClient([process.execPath, '-e', cappedServer], ws.root);
  const uri = 'file:///test.ts';
  try {
    await client.ready;
    client.openDocument(uri, 'typescript', 1, '1001');
    const published = await client.publishedDiagnostics(uri);
    assert.equal(client.alive, true, 'valid oversized diagnostics must not dispose the server');
    assert.equal(published.items.length, 1000); assert.equal(published.truncated, true);
    const last = published.items[999]; assert.ok(last && typeof last === 'object' && 'message' in last);
    assert.equal(last.message, 'error 999');
    const events = await client.request('events', {}); assert.ok(Array.isArray(events)); assert.equal(events.length, 1);
    client.openDocument(uri, 'typescript', 2, '1000');
    const full = await client.publishedDiagnostics(uri);
    assert.equal(full.items.length, 1000); assert.equal(full.truncated, false);
    client.closeDocument(uri);
    assert.equal(client.diagnostics.has(uri), false);
    client.openDocument(uri, 'typescript', 3, '0');
    assert.deepEqual(await client.publishedDiagnostics(uri), { items: [], truncated: false });
  } finally { client.dispose(); }
}));

test('Problems propagates push diagnostics truncation without killing the language server', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  await fs.writeFile(path.join(ws.projectDir('P'), 'a.ts'), '1001');
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, { typescript: [process.execPath, '-e', cappedServer] });
  try {
    const result = await editor.problems('P', '');
    assert.equal(result.problems.length, 1000); assert.equal(result.truncated, true);
    assert.equal(result.problems[999]?.message, 'error 999');
    await fs.writeFile(path.join(ws.projectDir('P'), 'a.ts'), '1');
    await editor.close('P', '', 'a.ts');
    const next = await editor.problems('P', '');
    assert.equal(next.problems.length, 1); assert.equal(next.truncated, false);
    assert.equal(next.problems[0]?.message, 'error 0');
  } finally { editor.dispose(); }
}));

