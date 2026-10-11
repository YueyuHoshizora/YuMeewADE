import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { parseMentions, resolveMentions } from './mentions.ts';

test('mentions parse paths, single lines, ranges and deduplicate without matching emails', () => {
  const mentions = parseMentions('a@b.com @src/a.ts @src/a.ts @b#L5 @c#L10-20');
  assert.deepEqual(mentions.map(m => [m.path, m.start, m.end]), [['src/a.ts', undefined, undefined], ['b', 5, 5], ['c', 10, 20]]);
});
test('references number lines, honor ranges, preserve failures and reject secrets, binaries and escaping symlinks', () => withTmpWorkspace(async ws => {
  const root = path.join(ws.root, 'files'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.ts'), 'first\nsecond\nthird');
  await fs.writeFile(path.join(root, '.env.local'), 'secret');
  await fs.writeFile(path.join(root, '.npmrc'), 'secret');
  await fs.writeFile(path.join(root, '.dev.vars'), 'secret');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await fs.symlink(path.join(root, '.env.local'), path.join(root, 'alias'));
  await fs.writeFile(path.join(ws.root, 'outside'), 'outside secret');
  await fs.symlink(path.join(ws.root, 'outside'), path.join(root, 'escape'));
  const result = await resolveMentions('@a.ts#L2-3 @missing @.env.local @.npmrc @.dev.vars @binary @../outside @escape @alias @a.ts#L0 @a.ts#L8', root);
  assert.match(result.text, /2: second\n3: third/u);
  assert.doesNotMatch(result.text, /1: first|outside secret|\nsecret/u);
  assert.deepEqual(result.mentions.map(m => m.status), ['resolved', 'not-found', 'excluded', 'excluded', 'excluded', 'binary', 'excluded', 'excluded', 'excluded', 'excluded', 'not-found']);
  const single = await resolveMentions('@a.ts#L2', root);
  assert.match(single.text, /2: second/u); assert.doesNotMatch(single.text, /3: third/u);
}));
test('reads respect per-file and total byte caps and report truncation even when budget is exhausted', () => withTmpWorkspace(async ws => {
  await fs.writeFile(path.join(ws.root, 'a'), 'abcdefghij');
  await fs.writeFile(path.join(ws.root, 'b'), 'ABCDEFGHIJ');
  await fs.writeFile(path.join(ws.root, 'c'), 'last');
  const result = await resolveMentions('@a @b @c', ws.root, { mentionFileBytes: 5, mentionTotalBytes: 8 });
  assert.match(result.text, /1: abcde/u); assert.match(result.text, /1: ABC/u);
  assert.doesNotMatch(result.text, /abcdefghij|ABCDEFGHIJ|1: last/u);
  assert.deepEqual(result.mentions.map(m => m.status), ['truncated', 'truncated', 'truncated']);
  assert.match(result.text, /引用已截斷/u);
}));
test('UTF-8 byte boundaries never turn truncated text into binary or replacement characters', () => withTmpWorkspace(async ws => {
  await fs.writeFile(path.join(ws.root, 'unicode'), '你好世界');
  const result = await resolveMentions('@unicode', ws.root, { mentionFileBytes: 4 });
  assert.equal(result.mentions[0]?.status, 'truncated');
  assert.match(result.text, /1: 你/u); assert.doesNotMatch(result.text, /�/u);
}));
