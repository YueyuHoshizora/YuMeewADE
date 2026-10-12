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
const { ApiFailure, NetworkFailure, request } = await import('../api.ts');
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

test('error messages keep localized user errors and server details and reserve "connection failed" for an unreachable core', () => {
  assert.equal(errorMessage(new UserError('Save the file first')), 'Save the file first');
  assert.equal(errorMessage(new ApiFailure(409, { error: 'conflict', message: '狀態衝突', detail: 'editor_conflict' })), `409 · ${t('detail.editor_conflict')}`);
  assert.equal(errorMessage(new ApiFailure(403, { error: 'forbidden', message: '未允許' })), `403 · ${t('err.forbidden')}`);
  // Only an unreachable core is a connection failure; other client errors say "internal" without leaking developer text.
  assert.equal(errorMessage(new NetworkFailure()), t('err.network'));
  const logged = console.error; console.error = () => {};
  try {
    assert.equal(errorMessage(new SyntaxError('Unexpected token')), t('err.internal'));
    assert.equal(errorMessage(new Error('internal detail')), t('err.internal'));
  } finally { console.error = logged; }
});

test('requests distinguish an unreachable core from a reply that is not the core JSON', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(request('/api/state'), NetworkFailure);
    globalThis.fetch = async () => new Response('<html>Bad gateway</html>', { status: 502 });
    await assert.rejects(request('/api/state'), (error: unknown) => error instanceof ApiFailure && error.status === 502 && error.body.error === 'internal');
    globalThis.fetch = async () => new Response('not json', { status: 200 });
    await assert.rejects(request('/api/state'), (error: unknown) => error instanceof ApiFailure && error.body.error === 'internal');
    globalThis.fetch = async () => Response.json({ error: 'conflict', message: 'x', detail: 'editor_conflict' }, { status: 409 });
    await assert.rejects(request('/api/state'), (error: unknown) => error instanceof ApiFailure && error.body.detail === 'editor_conflict');
  } finally { globalThis.fetch = original; }
});
