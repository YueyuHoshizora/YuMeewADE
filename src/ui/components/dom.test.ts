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
const { button: makeButton, iconButton, setLocked, statusRegion, errorMessage, UserError } = await import('./dom.ts');
const { ApiFailure } = await import('../api.ts');
const { t } = await import('../i18n/index.ts');

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

test('a button locked by its own action stays disabled afterwards until unlocked', async () => {
  // E.g. "detach" re-renders a closed session and must not come back enabled when its action ends.
  const control: HTMLButtonElement = makeButton('Stop', async () => { setLocked(control, true); });
  const node = control as unknown as Element;
  node.onclick!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(node.disabled, true);
  setLocked(control, false);
  assert.equal(node.disabled, false);
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

test('error messages keep localized user errors and server details instead of a generic network failure', () => {
  assert.equal(errorMessage(new UserError('Save the file first')), 'Save the file first');
  assert.equal(errorMessage(new ApiFailure(409, { error: 'conflict', message: '狀態衝突', detail: 'editor_conflict' })), `409 · ${t('detail.editor_conflict')}`);
  assert.equal(errorMessage(new ApiFailure(403, { error: 'forbidden', message: '未允許' })), `403 · ${t('err.forbidden')}`);
  // Raw fetch/parse failures carry developer text; only those collapse to the network message.
  assert.equal(errorMessage(new TypeError('Failed to fetch')), t('err.network'));
  assert.equal(errorMessage(new Error('internal detail')), t('err.network'));
});
