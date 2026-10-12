import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from './frontmatter.ts';
import { YamlError } from './yaml.ts';

const SAMPLE = `---
id: 20261010-001
title: 標題   # 顯示於清單
state: 未開始
question:
issues:
  - { text: a, level: 高 }
---
## 步驟
- [ ] x
`;

test('解析 frontmatter 與正文', () => {
  const fm = parseFrontmatter(SAMPLE);
  assert.equal(fm.data['id'], '20261010-001');
  assert.equal(fm.data['question'], null);
  assert.deepEqual(fm.data['issues'], [{ text: 'a', level: '高' }]);
  assert.equal(fm.body, '## 步驟\n- [ ] x\n');
});

test('patch 只改動指定鍵、保留註解與其他行、補新鍵', () => {
  const fm = parseFrontmatter(SAMPLE);
  const lines = patchHeaderLines(fm.headerLines, { state: '進行中', issues: [], title: '新標題', updated: '2026-10-10 12:00' });
  const text = serializeFrontmatter(lines, fm.body);
  const again = parseFrontmatter(text);
  assert.equal(again.data['state'], '進行中');
  assert.equal(again.data['title'], '新標題');
  assert.deepEqual(again.data['issues'], []);
  assert.equal(again.data['updated'], '2026-10-10 12:00');
  assert.equal(again.data['question'], null);
  assert.match(text, /title: 新標題 +# 顯示於清單/);
  assert.equal(again.body, fm.body);
});

test('patching a key keeps standalone comments and blank lines after it, including at the end of the header', () => {
  const header = ['name: P', 'description: old', '', '# explains custom', 'custom: kept', 'updated: 2026-10-01', '# footer note'];
  const lines = patchHeaderLines(header, { description: 'new', updated: '2026-10-13' });
  assert.deepEqual(lines, ['name: P', 'description: new', '', '# explains custom', 'custom: kept', 'updated: 2026-10-13', '# footer note']);
  // Indented lines inside a value still belong to it and are replaced with it.
  assert.deepEqual(patchHeaderLines(['list:', '  - a', '  - b', '# after'], { list: ['c'] }), ['list: [c]', '# after']);
});

test('patching keeps keys the YAML parser reads: quoted keys with colons, keys starting with -, escaped key names', () => {
  for (const custom of ['"custom:key": important', '-custom: important']) {
    const lines = patchHeaderLines(['title: old', custom, 'state: open'], { title: 'new' });
    assert.deepEqual(lines, ['title: new', custom, 'state: open']);
  }
  // `"\u0074itle"` is the key title: patching replaces that line instead of adding a duplicate.
  const escaped = patchHeaderLines(['"\\u0074itle": old', 'state: open'], { title: 'new' });
  assert.deepEqual(parseFrontmatter(serializeFrontmatter(escaped, '')).data, { title: 'new', state: 'open' });
});

test('缺少 --- 時丟錯', () => {
  assert.throws(() => parseFrontmatter('no frontmatter'), YamlError);
  assert.throws(() => parseFrontmatter('---\na: 1\n'), YamlError);
});

test('a ledger file saved with a UTF-8 byte order mark still parses', () => {
  const parsed = parseFrontmatter('\uFEFF---\r\nname: P\r\n---\r\nbody');
  assert.equal(parsed.data['name'], 'P');
  assert.equal(parsed.body, 'body');
});
