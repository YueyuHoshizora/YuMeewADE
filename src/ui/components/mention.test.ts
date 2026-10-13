/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMention, attachComposeInsert, mentionAt } from './mention.ts';
import { MENTION_PATTERN, mentionReference, mentionTarget } from '../../shared/mention-syntax.ts';

test('mentionAt only fires for an @token right before the caret', () => {
  assert.deepEqual(mentionAt('看 @src/a', 8), { start: 2, query: 'src/a' });
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('line1\n@x', 8), { start: 6, query: 'x' });
  assert.equal(mentionAt('mail me at a@b.c', 16), null, 'an @ inside a word is not a mention');
  assert.equal(mentionAt('@src/a done', 11), null, 'a space ends the token');
  assert.equal(mentionAt('@a', 0), null, 'caret before the @');
  assert.deepEqual(mentionAt('x @a rest', 4), { start: 2, query: 'a' }, 'text after the caret is ignored');
  assert.deepEqual(mentionAt('請看（@src', 7), { start: 3, query: 'src' }, 'an opening bracket starts a mention, as the core reads it');
});

test('applyMention replaces the whole token the caret is in and keeps the prose after it', () => {
  const text = '請看 @src/ rest';
  const mention = mentionAt(text, 8)!;
  assert.deepEqual(applyMention(text, mention, 8, 'src/app.ts'), { text: '請看 @src/app.ts rest', caret: 15 });
  // Caret inside the token: the part after the caret belongs to the token being replaced.
  const inside = 'Please inspect @src/main.ts carefully';
  assert.equal(applyMention(inside, mentionAt(inside, 20)!, 20, 'src/main.ts').text, 'Please inspect @src/main.ts carefully');
  const quoted = 'see @"my fi" next';
  assert.equal(applyMention(quoted, mentionAt(quoted, 8)!, 8, 'my file.ts').text, 'see @"my file.ts" next');
});

test('a picked path containing @ or a quote is written so the core reads the same path back', () => {
  for (const file of ['src/user@domain.ts', 'a"b.ts', '"lead.ts', 'plain/a.ts']) {
    const matches = [...`see ${mentionReference(file)} now`.matchAll(MENTION_PATTERN)];
    assert.deepEqual(matches.map(mentionTarget), [file], file);
  }
});

test('compose insertion replaces selection, focuses, notifies draft persistence, scopes projects/tasks and cleans up', () => {
  const target = new EventTarget();
  let value = 'before selected after';
  let start = 7; let end = 15; let focused = false; let inputs = 0;
  const input = {
    get selectionStart() { return start; }, get selectionEnd() { return end; },
    setRangeText(text: string, from: number, to: number) { value = value.slice(0, from) + text + value.slice(to); start = end = from + text.length; },
    dispatchEvent(event: Event) { if (event.type === 'input') inputs++; return true; },
    focus() { focused = true; },
  } as HTMLTextAreaElement;
  const dispose = attachComposeInsert(input, 'P', 'T', target);
  const emit = (detail: unknown) => target.dispatchEvent(Object.assign(new Event('yumeewade:compose-insert'), { detail }));
  for (const detail of [null, { project: 'Other', task: 'T', text: 'no' }, { project: 'P', task: '', text: 'no' }, { project: 'P', task: 'T', text: 1 }]) emit(detail);
  assert.equal(inputs, 0);
  emit({ project: 'P', task: 'T', text: '@file#L2-3 ' });
  assert.equal(value, 'before @file#L2-3  after'); assert.equal(start, 18); assert.equal(end, start); assert.equal(focused, true); assert.equal(inputs, 1);
  dispose(); emit({ project: 'P', task: 'T', text: 'no' }); assert.equal(inputs, 1);
  const quickDispose = attachComposeInsert(input, 'P', '', target);
  emit({ project: 'P', task: '', text: 'quick' }); assert.equal(inputs, 2);
  quickDispose();
});
