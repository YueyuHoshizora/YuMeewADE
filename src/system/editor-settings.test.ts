import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSettingsStore, validateEditorCommands, applyEditorConfig, validateEditorFormat, DEFAULT_EDITOR_FORMAT } from './editor-settings.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';

test('language server settings persist exact argv and reject stale revisions and unbounded configuration', () => withTmpWorkspace(async (_ws, directory) => {
  const store = new EditorSettingsStore(directory);
  const seed = { typescript: ['local-server', '--stdio'] };
  const before = await store.get('P', seed);
  const saved = await store.update('P', { revision: before.revision, commands: { python: ['python-lsp', '--stdio'] }, format: { tabSize: 8, insertSpaces: false, eol: 'crlf' } }, seed);
  assert.deepEqual((await new EditorSettingsStore(directory).get('P', seed)).commands, saved.commands);
  assert.deepEqual((await new EditorSettingsStore(directory).get('P', seed)).format, { tabSize: 8, insertSpaces: false, eol: 'crlf' });
  assert.notEqual(saved.revision, before.revision);
  await assert.rejects(store.update('P', { revision: before.revision, commands: {} }, seed));
  assert.deepEqual({ ...(await store.get('Q', seed)).commands }, seed);
  for (const value of [{ python: [] }, { python: ['x\0y'] }, { '../secret': ['x'] }, { python: Array.from({ length: 65 }, () => 'x') }]) assert.throws(() => validateEditorCommands(value));
}));

test('EditorConfig subset applies scoped globs, order, tab widths and validation', () => {
  const config = '[*]\nindent_style = tab\nindent_size = tab\ntab_width = 8\nend_of_line = crlf\n[*.ts]\nindent_size = 3\n';
  assert.deepEqual(applyEditorConfig(config, 'src/a.ts', DEFAULT_EDITOR_FORMAT), { tabSize: 3, insertSpaces: false, eol: 'crlf' });
  assert.deepEqual(applyEditorConfig('[src/*.ts]\nindent_size = 7\n', 'lib/a.ts', DEFAULT_EDITOR_FORMAT), DEFAULT_EDITOR_FORMAT);
  assert.equal(applyEditorConfig('[*.ts]\nindent_size = 7\n[*.ts]\nindent_size = unset\n', 'a.ts', DEFAULT_EDITOR_FORMAT).tabSize, 4);
  // A leading `/` anchors to the .editorconfig folder; `*` (and `src/*`) include dotfiles; literal dot segments match themselves.
  assert.equal(applyEditorConfig('[/foo.txt]\nindent_size = 2\n', 'nested/foo.txt', DEFAULT_EDITOR_FORMAT).tabSize, 4);
  assert.equal(applyEditorConfig('[/foo.txt]\nindent_size = 2\n', 'foo.txt', DEFAULT_EDITOR_FORMAT).tabSize, 2);
  assert.equal(applyEditorConfig('[*]\nindent_size = 2\n', '.hidden', DEFAULT_EDITOR_FORMAT).tabSize, 2);
  assert.equal(applyEditorConfig('[src/*]\nindent_size = 2\n', 'src/.eslintrc', DEFAULT_EDITOR_FORMAT).tabSize, 2);
  assert.equal(applyEditorConfig('[.eslintrc]\nindent_size = 2\n', 'deep/.eslintrc', DEFAULT_EDITOR_FORMAT).tabSize, 2);
  assert.equal(applyEditorConfig('[.eslintrc]\nindent_size = 2\n', 'eslintrc', DEFAULT_EDITOR_FORMAT).tabSize, 4);
  assert.throws(() => applyEditorConfig('[*]\nindent_size = 99\n', 'a.ts', DEFAULT_EDITOR_FORMAT));
  assert.throws(() => validateEditorFormat({ tabSize: 0, insertSpaces: true, eol: 'lf' }));
  assert.throws(() => validateEditorFormat({ tabSize: 4, insertSpaces: true, eol: 'cr' }));
});
