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
