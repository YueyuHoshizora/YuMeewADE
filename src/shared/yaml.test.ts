import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseYaml, parseYamlMap, stringifyYaml, yamlScalar, YamlError } from './yaml.ts';

test('純量：字串、數字、布林、null、引號與註解', () => {
  const v = parseYamlMap(`
name: 範例 專案   # 註解
port: 4560
flag: true
nothing:
tilde: ~
q: "a: b # not comment"
s: 'it''s'
url: http://127.0.0.1:4560
`);
  assert.deepEqual(v, {
    name: '範例 專案',
    port: 4560,
    flag: true,
    nothing: null,
    tilde: null,
    q: 'a: b # not comment',
    s: "it's",
    url: 'http://127.0.0.1:4560',
  });
});

test('行內清單與 map 可巢狀（roles.yaml 形式）', () => {
  const v = parseYamlMap(`roles:
  規劃: { main: [claude, opus, high],   backup: [codex, default, high], job: 規劃、分工 }
  最終確認: { main: [人], backup: [人], job: 判斷是否完成 }
models:
  claude: [opus, "son, net", haiku]
  empty: []
`);
  assert.deepEqual(v, {
    roles: {
      規劃: { main: ['claude', 'opus', 'high'], backup: ['codex', 'default', 'high'], job: '規劃、分工' },
      最終確認: { main: ['人'], backup: ['人'], job: '判斷是否完成' },
    },
    models: { claude: ['opus', 'son, net', 'haiku'], empty: [] },
  });
});

test('區塊清單：純量、行內 map、map 項、同縮排清單', () => {
  const v = parseYamlMap(`issues:
  - { text: 第一, level: 高 }
  - text: 第二
    level: 低
list:
- a
- b
nested:
  inner:
    - 1
    - 2
`);
  assert.deepEqual(v, {
    issues: [
      { text: '第一', level: '高' },
      { text: '第二', level: '低' },
    ],
    list: ['a', 'b'],
    nested: { inner: [1, 2] },
  });
});

test('不支援的語法會丟 YamlError 並帶行號', () => {
  assert.throws(() => parseYaml('a: |\n  x\n'), (e: unknown) => e instanceof YamlError && e.line === 1);
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), YamlError);
  assert.throws(() => parseYaml('a: [1, 2\n'), YamlError);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), YamlError);
  assert.throws(() => parseYaml('\tx: 1\n'), YamlError);
  assert.throws(() => parseYamlMap('- a\n'), YamlError);
});

test('序列化後可再解析（往返）', () => {
  const data = {
    name: '專案: 測試',
    status: '進行中',
    updated: '2026-10-10',
    related: ['a', 'b c'],
    issues: [{ text: '有 #號', level: '高' }],
    nested: { k: 'v', n: 3, b: false, nil: null, empty: '' },
    multi: [[1, 2], { x: [1] }],
  };
  const text = stringifyYaml(data).join('\n');
  assert.deepEqual(parseYamlMap(text), data);
});

test('行內清單與 map 的分隔符、空白、引號及 Unicode 字串完整往返', () => {
  const strings = ['build, test', 'A]B', 'x}y', 'A[B', 'x{y', 'a: b', 'a:b', 'a # b', ' lead', 'tail ', '雙語 🌙', 'a"b', "a'b", '"quoted"', "'quoted'", 'a\t#b', 'line\nbreak'];
  const data = { phases: strings.map((name) => ({ name, state: '進行中', [name]: name })), tags: strings };
  assert.deepEqual(parseYamlMap(stringifyYaml(data).join('\n')), data);
  assert.deepEqual(stringifyYaml({ name: 'build, test', bracket: 'A]B', brace: 'x}y' }), ['name: build, test', 'bracket: A]B', 'brace: x}y']);
});

test('yamlScalar 對特殊字串加引號', () => {
  assert.equal(yamlScalar('plain 文字'), 'plain 文字');
  assert.equal(yamlScalar('true'), '"true"');
  assert.equal(yamlScalar('123'), '"123"');
  assert.equal(yamlScalar(''), '""');
  assert.equal(yamlScalar('a: b'), '"a: b"');
  assert.equal(yamlScalar('- item'), '"- item"');
  assert.equal(yamlScalar(' lead'), '" lead"');
});

test('a UTF-8 byte order mark from a Windows editor does not hide the first key', () => {
  assert.deepEqual(parseYamlMap('\uFEFFserver:\n  port: 4561\nroles:\n  - a'), { server: { port: 4561 }, roles: ['a'] });
});

test('an apostrophe inside a plain scalar does not swallow the comment after it', () => {
  assert.deepEqual(parseYamlMap("title: Bob's task # maintainer note\nnote: don't"), { title: "Bob's task", note: "don't" });
  // Quoted scalars still keep `#` and the `''` escape; a comment after them is still a comment.
  assert.deepEqual(parseYamlMap("a: 'it''s # x' # y\nb: \"c # d\" # e\nc: [x, 'y # z'] # w"), { a: "it's # x", b: 'c # d', c: ['x', 'y # z'] });
});
