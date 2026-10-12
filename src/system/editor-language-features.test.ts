import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageClient } from './editor-lsp.ts';
import { advancedLanguage } from './editor-language-features.ts';
test('advanced features gate capabilities and strip executable hint payloads', async () => {
  const unsupported = { capabilities: {}, request: async () => { throw new Error('must not request'); } } as unknown as LanguageClient;
  await assert.rejects(advancedLanguage(unsupported, 'inlayHints', 'file:///repo/a.ts', '/repo', 'x', 0, 0, async () => undefined));
  const hints = { capabilities: { inlayHintProvider: true }, request: async () => [{ position: { line: 0, character: 1 }, label: [{ value: ': number', command: { command: 'danger' } }], textEdits: [{ newText: 'danger' }] }] } as unknown as LanguageClient;
  assert.deepEqual(await advancedLanguage(hints, 'inlayHints', 'file:///repo/a.ts', '/repo', 'x', 0, 0, async () => undefined), { inlayHints: [{ line: 0, character: 1, label: ': number' }] });
});
test('a function with more callers than are listed keeps the first ones and marks the hierarchy as cut', async () => {
  const item = { name: 'log', uri: 'file:///repo/a.ts', selectionRange: { start: { line: 0, character: 0 } } };
  const caller = (i: number) => ({ from: { name: `caller${i}`, uri: 'file:///repo/a.ts', selectionRange: { start: { line: i, character: 0 } } } });
  const client = { capabilities: { callHierarchyProvider: true }, request: async (method: string) => method === 'textDocument/prepareCallHierarchy' ? [item] : method === 'callHierarchy/incomingCalls' ? Array.from({ length: 150 }, (_, i) => caller(i)) : [] } as unknown as LanguageClient;
  const result = await advancedLanguage(client, 'callHierarchy', 'file:///repo/a.ts', '/repo', 'x', 0, 0, async () => undefined);
  assert.equal(result.callHierarchy?.length, 100);
  assert.equal(result.truncated, true);
});
