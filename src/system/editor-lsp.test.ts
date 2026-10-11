import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanguageClient } from './editor-lsp.ts';

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
    assert.equal((await client.publishedDiagnostics(uri) as { message: string }[])[0]?.message, 'bad unsaved');
    client.openDocument(uri, 'typescript', 2, 'fixed');
    assert.deepEqual(await client.publishedDiagnostics(uri), []);
    client.closeDocument(uri);
    assert.equal(client.diagnostics.has(uri), false);
    client.openDocument(uri, 'typescript', 3, 'bad reopened');
    assert.equal((await client.publishedDiagnostics(uri) as { message: string }[])[0]?.message, 'bad reopened');
    const events = await client.request('events', {}) as { method: string; params: { textDocument: { version: number }; contentChanges?: { text: string }[] } }[];
    assert.deepEqual(events.map(event => event.method), ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didOpen']);
    assert.equal(events[1]?.params.textDocument.version, 2);
    assert.equal(events[1]?.params.contentChanges?.[0]?.text, 'fixed');
  } finally { client.dispose(); }
});
