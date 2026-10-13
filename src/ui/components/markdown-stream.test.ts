import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownStream } from './markdown-stream.ts';

test('stream retains longer fences across shorter examples and blank lines', () => {
  const stream = new MarkdownStream();
  const open = '````markdown\n```ts\ncode\n\n```\n\ninside\n';
  for (const char of open) stream.push(char);
  assert.deepEqual(stream.takeCompleted(), []);
  assert.equal(stream.tail(), open);
  stream.push('`````\n\nafter');
  assert.deepEqual(stream.takeCompleted(), [open + '`````\n\n']);
  assert.equal(stream.tail(), 'after');
});

test('stream retains list continuation fences and rejects wrong closing markers', () => {
  const stream = new MarkdownStream();
  const open = '- Example\n    ~~~~ts\n    code\n    ```\n    ~~~\n    ~~~~ trailing\n\n    inside\n';
  for (const char of open) stream.push(char);
  assert.deepEqual(stream.takeCompleted(), []);
  assert.equal(stream.tail(), open);
  stream.push('    ~~~~~\n\nafter');
  assert.deepEqual(stream.takeCompleted(), [open + '    ~~~~~\n\n']);
  assert.equal(stream.tail(), 'after');
});
