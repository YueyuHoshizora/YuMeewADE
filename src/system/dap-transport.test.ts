import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnCli, minimalEnv } from '../cli/process.ts';
import { DapTransport } from './dap-transport.ts';

// A protocol peer fixture exercises real pipes without requiring a third-party adapter.
const peer = `
let pending = Buffer.alloc(0), seq = 0;
function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: ++seq, ...message }));
  const bytes = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]);
  // Deliberately split the header, JSON and multibyte UTF-8 across writes.
  for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
}
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const end = pending.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
    const length = Number(pending.subarray(0, end).toString().split(':')[1]);
    if (pending.length < end + 4 + length) return;
    const message = JSON.parse(pending.subarray(end + 4, end + 4 + length)); pending = pending.subarray(end + 4 + length);
    if (message.type === 'request') {
      send({ type: 'event', event: 'initialized' });
      send({ type: 'response', command: message.command, request_seq: message.seq, success: true, body: { result: '中文 🐾' } });
      send({ type: 'request', command: 'runInTerminal', arguments: { args: ['never-executed'] } });
    } else if (message.type === 'response') {
      send({ type: 'event', event: 'reverseResult', body: { accepted: message.success, command: message.command } });
    }
  }
});
`;

test('DAP fragmented UTF-8 framing, event delivery and reverse launch fail closed', async () => {
  const child = spawnCli(process.execPath, ['-e', peer], { env: minimalEnv([]), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const reverse = Promise.withResolvers<Record<string, unknown>>(); const events: string[] = [];
  const transport = new DapTransport(child, (name, body) => { events.push(name); if (name === 'reverseResult') reverse.resolve(body); }, reason => reverse.reject(new Error(reason)));
  try {
    assert.deepEqual(await transport.request('evaluate'), { result: '中文 🐾' });
    assert.deepEqual(await reverse.promise, { accepted: false, command: 'runInTerminal' });
    assert.ok(events.includes('initialized'));
  } finally { transport.close(); }
});
