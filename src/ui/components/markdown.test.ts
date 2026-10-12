import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownStream } from './markdown-stream.ts';

// Minimal text-only DOM fixture: markup must be represented as elements, never parsed HTML.
class Element {
  tag: string;
  children: Element[] = [];
  textContent = '';
  className = '';
  href = '';
  style: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]): void { this.children.push(...nodes); }
}
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
Object.defineProperty(globalThis, 'document', {
  value: {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  },
  configurable: true,
});
// Locale initialization reads browser globals at import time; load after the fixture exists.
const { markdown, copyText } = await import('./markdown.ts');
function shape(node: Element): unknown {
  return [node.tag, node.textContent, node.href, node.style, node.children.map(shape)];
}
function elements(node: Element): Element[] {
  return [node, ...node.children.flatMap(elements)];
}

test('markdown keeps raw HTML as text and links only HTTP(S)', () => {
  const raw = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  const root = markdown(`${raw}\n[bad](javascript:alert) [data](data:text/html,x) [good](https://example.com) http://example.org`) as unknown as Element;
  const nodes = elements(root);
  assert.equal(nodes.some(node => node.tag === 'img' || node.tag === 'script'), false);
  assert.ok(nodes.some(node => node.textContent.includes(raw)));
  assert.deepEqual(nodes.filter(node => node.tag === 'a').map(node => node.href), ['https://example.com', 'http://example.org']);
  assert.ok(nodes.some(node => node.textContent.includes('[bad](javascript:alert)')));
});

test('incremental blank-line blocks produce exactly the full markdown children', () => {
  for (const source of [
    'first **paragraph**\nsecond line\n\n# Heading\n\nlast',
    '- one\n- two\n\n1. next\n2. item\n\nend\n',
    'before\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nafter',
    '| A | B |\n| --- | ---: |\n| one | two |\n\nnext',
    '```\nunclosed\n\nfence',
    'a\r\n\r\nb\n\n',
    // A fence line right after table rows ends the table even when it contains `|`.
    '| A |\n| --- |\n``` | row\n\n```js\none\n\ntwo\n```\n',
  ]) {
    for (const size of [1, 3, 11, source.length]) {
      const buffer = new MarkdownStream();
      const completed: Element[] = [];
      for (let at = 0; at < source.length; at += size) {
        buffer.push(source.slice(at, at + size));
        for (const block of buffer.takeCompleted()) {
          completed.push(...(markdown(block) as unknown as Element).children);
        }
      }
      completed.push(...(markdown(buffer.tail()) as unknown as Element).children);
      const full = markdown(source) as unknown as Element;
      assert.deepEqual(completed.map(shape), full.children.map(shape), `chunk size ${size}: ${source}`);
    }
  }
});

test('completed blocks are drained once while open fences stay in the tail', () => {
  const buffer = new MarkdownStream();
  buffer.push('done\n\n```\ncode\n\n');
  assert.deepEqual(buffer.takeCompleted(), ['done\n\n']);
  assert.deepEqual(buffer.takeCompleted(), []);
  assert.equal(buffer.tail(), '```\ncode\n\n');
  buffer.push('```\n\nnext');
  assert.deepEqual(buffer.takeCompleted(), ['```\ncode\n\n```\n\n']);
  assert.equal(buffer.tail(), 'next');
});

test('copy uses the clipboard directly when available', async () => {
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text: string) => { copied = text; } } }, configurable: true });
  await copyText('user <script>text</script>');
  assert.equal(copied, 'user <script>text</script>');
});

test('clipboard rejection falls back to selected text and restores focus', async () => {
  const originalDocument = globalThis.document;
  const previous = new Element('button');
  let focused = false;
  let selected = false;
  let removed = false;
  let commandResult = true;
  let fallback: (Element & { value: string }) | undefined;
  Object.assign(previous, { focus: () => { focused = true; } });
  Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: previous,
      createElement: (tag: string) => Object.assign(new Element(tag), {
        value: '', select: () => { selected = true; }, remove: () => { removed = true; },
      }),
      body: { append: (node: typeof fallback) => { fallback = node; } },
      execCommand: (command: string) => { assert.equal(command, 'copy'); return commandResult; },
    },
    configurable: true,
  });
  try {
    await copyText('assistant text');
    assert.equal(fallback!.value, 'assistant text');
    assert.ok(selected && removed && focused);
    commandResult = false;
    removed = false;
    focused = false;
    await assert.rejects(copyText('failure'));
    assert.ok(removed && focused);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
  }
});

test('a link whose text differs from its target also shows the real host, so a label cannot disguise the destination', () => {
  const root = markdown('[https://github.com/me/repo/pull/12](https://attacker.example/?d=1) and https://example.org/plain') as unknown as Element;
  const nodes = elements(root);
  const disguised = nodes.find(node => node.tag === 'a' && node.href === 'https://attacker.example/?d=1')!;
  const shown = root.children.flatMap(elements).map(node => node.textContent).join('');
  assert.match(shown, /pull\/12 \(attacker\.example\)/);
  assert.equal((disguised as unknown as { title: string }).title, 'https://attacker.example/?d=1');
  // A bare URL already shows where it goes.
  assert.doesNotMatch(shown, /\(example\.org\)/);
});
