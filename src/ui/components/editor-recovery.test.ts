import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRecovery } from './editor-recovery.ts';

const draft = (path: string, text: string) => ({ document: { path, revision: 'r', text: 'disk' }, text });
const clean = (path: string) => ({ document: { path, revision: 'r', text: '' }, text: '', clean: true });
const record = (at: number, buffers: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 4, at, buffers, ...extra });
const paths = (raw: string | null) => (JSON.parse(raw!) as { buffers: { document: { path: string }; text: string }[] }).buffers.map(b => `${b.document.path}=${b.text}`);

test('a live window keeps its drafts; this window never takes them over', () => {
  const own = record(1000, [clean('a.ts')]);
  const result = mergeRecovery(own, [{ key: 'w:other', raw: record(990, [draft('a.ts', 'typed in other window')]) }], 1000, 30);
  assert.equal(result.raw, own);
  assert.deepEqual(result.adopted, []);
});

test('drafts of a closed or crashed window are merged, replacing a clean entry for the same file', () => {
  const result = mergeRecovery(record(100_000, [clean('a.ts')]), [{ key: 'w:dead', raw: record(1, [draft('a.ts', 'A'), draft('b.ts', 'B'), clean('c.ts')]) }], 100_000, 30_000);
  assert.deepEqual(paths(result.raw), ['a.ts=A', 'b.ts=B']);
  assert.deepEqual(result.adopted, ['w:dead']);
});

test('a stale record holding the same draft this window already restored is dropped', () => {
  const result = mergeRecovery(record(100_000, [draft('a.ts', 'same')]), [{ key: 'w:dead', raw: record(1, [draft('a.ts', 'same')]) }], 100_000, 30_000);
  assert.deepEqual(paths(result.raw), ['a.ts=same']);
  assert.deepEqual(result.adopted, ['w:dead']);
});

test('a draft colliding with this window\'s own draft is kept in storage instead of being dropped', () => {
  const result = mergeRecovery(record(100_000, [draft('a.ts', 'mine')]), [{ key: 'w:dead', raw: record(1, [draft('a.ts', 'theirs')]) }], 100_000, 30_000);
  assert.deepEqual(paths(result.raw), ['a.ts=mine']);
  assert.deepEqual(result.adopted, []);
});

test('without its own record a new window takes the newest stale layout and the legacy record\'s drafts', () => {
  const result = mergeRecovery(null, [
    { key: 'legacy', raw: JSON.stringify({ version: 4, buffers: [draft('old.ts', 'O')], panes: [{ path: 'old.ts' }] }) },
    { key: 'w:newer', raw: record(50, [clean('new.ts')], { panes: [{ path: 'new.ts' }] }) },
    { key: 'w:broken', raw: '{' },
  ], 100_000, 30_000);
  const state = JSON.parse(result.raw!) as { panes: { path: string }[] };
  assert.equal(state.panes[0]!.path, 'new.ts');
  assert.deepEqual(paths(result.raw), ['new.ts=', 'old.ts=O']);
  assert.deepEqual(result.adopted.sort(), ['legacy', 'w:newer']);
});

test('this window\'s own corrupt record is reported rather than silently replaced', () => {
  assert.throws(() => mergeRecovery('{', [{ key: 'w:dead', raw: record(1, [draft('a.ts', 'A')]) }], 100_000, 30_000), SyntaxError);
});
