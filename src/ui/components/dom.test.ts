import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  tag: string;
  textContent = '';
  className = '';
  disabled = false;
  onclick: (() => void) | null = null;
  attributes: Record<string, string> = {};

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}
Object.defineProperty(globalThis, 'document', {
  value: { createElement: (tag: string) => new Element(tag) },
  configurable: true,
});
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => null },
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en' },
  configurable: true,
});
// Locale initialization reads browser globals, so import only after installing the fixture.
const { iconButton, statusRegion } = await import('./dom.ts');

test('icon controls expose a contextual accessible name and disable during their action', async () => {
  const pending = Promise.withResolvers<void>();
  const button = iconButton('×', 'Remove image: photo.png', () => pending.promise) as unknown as Element;
  assert.equal(button.tag, 'button');
  assert.equal(button.textContent, '×');
  assert.equal(button.attributes['aria-label'], 'Remove image: photo.png');
  button.onclick!();
  assert.equal(button.disabled, true);
  pending.resolve();
  await pending.promise;
  assert.equal(button.disabled, false);
  assert.equal(button.attributes['aria-label'], 'Remove image: photo.png');
});

test('status regions announce atomic polite updates and start empty', () => {
  const status = statusRegion() as unknown as Element;
  assert.deepEqual(status.attributes, {
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  assert.equal(status.textContent, '');
  assert.equal(status.className, 'visually-hidden');
});
