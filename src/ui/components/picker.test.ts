import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiPick, AppState } from '../../shared/types.ts';

// Model native select behavior: missing values clear the selection, and the first
// appended option is selected until a caller chooses another one.
class Element {
  tag: string;
  children: Element[] = [];
  className = '';
  textContent = '';
  title = '';
  disabled = false;
  onchange?: () => void;
  classList = { add: (_name: string) => {} };
  attributes = new Map<string, string>();
  private ownValue = '';
  private index = -1;
  constructor(tag: string) { this.tag = tag; }
  get options(): Element[] { return this.children; }
  get selectedIndex(): number { return this.index; }
  set selectedIndex(index: number) { this.index = index; }
  get value(): string { return this.tag === 'select' ? this.options[this.index]?.value ?? '' : this.ownValue; }
  set value(value: string) { if (this.tag === 'select') this.index = this.options.findIndex(o => o.value === value); else this.ownValue = value; }
  append(...children: Element[]): void {
    this.children.push(...children);
    if (this.tag === 'select' && this.index < 0 && this.children.length) this.index = 0;
  }
  replaceChildren(...children: Element[]): void { this.children = []; this.index = -1; this.append(...children); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
}
Object.defineProperty(globalThis, 'document', { value: { createElement: (tag: string) => new Element(tag) }, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
// Locale initialization needs browser globals installed before this module loads.
const { aiPicker } = await import('./picker.ts');

const state = {
  ais: [
    { name: 'codex', available: true, models: [
      { id: 'first', label: 'First', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'second', label: 'Second', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ] },
    { name: 'claude', available: true, models: [{ id: 'claude-model', label: 'Claude', efforts: ['high'], defaultEffort: 'high' }] },
  ],
  settings: { hiddenModels: {}, modelOrder: {} },
} as AppState;
function controls(node: HTMLElement): Element[] {
  const collect = (element: Element): Element[] => element.tag === 'select' ? [element] : element.children.flatMap(collect);
  return collect(node as unknown as Element);
}

test('unchanged role pickers preserve CLI-default model and effort when settings saves every slot', () => {
  const initial = { ai: 'codex', model: '', effort: '' };
  const picker = aiPicker(state, initial, undefined, true);
  assert.deepEqual(picker.value(), initial);
  const [, model, effort] = controls(picker.node);
  assert.equal(model!.options.find(o => o.value === '')?.textContent, 'Default');
  assert.equal(effort!.options.find(o => o.value === '')?.textContent, 'Default');
});

test('an explicit model keeps CLI-default effort in task and quick-start pickers', () => {
  const initial = { ai: 'codex', model: 'first', effort: '' };
  for (const compact of [false, true]) assert.deepEqual(aiPicker(state, initial, undefined, false, compact).value(), initial);
});

test('concrete saved picks remain selected and changing model or AI uses recommended effort', () => {
  const changes: AiPick[] = [];
  const initial = { ai: 'codex', model: 'first', effort: 'low' };
  const picker = aiPicker(state, initial, pick => changes.push(pick));
  assert.deepEqual(picker.value(), initial);
  const [ai, model, effort] = controls(picker.node);
  model!.value = 'second'; model!.onchange!();
  assert.deepEqual(picker.value(), { ai: 'codex', model: 'second', effort: 'medium' });
  effort!.value = ''; effort!.onchange!();
  assert.deepEqual(changes.at(-1), { ai: 'codex', model: 'second', effort: '' });
  model!.value = ''; model!.onchange!();
  assert.deepEqual(changes.at(-1), { ai: 'codex', model: '', effort: '' });
  ai!.value = 'claude'; ai!.onchange!();
  assert.deepEqual(changes.at(-1), { ai: 'claude', model: 'claude-model', effort: 'high' });
});

test('unavailable initial AI still falls back to a concrete available model', () => {
  assert.deepEqual(aiPicker(state, { ai: 'grok', model: '', effort: '' }).value(), { ai: 'codex', model: 'first', effort: 'high' });
});

test('unknown saved models and human slots keep their existing behavior', () => {
  assert.deepEqual(aiPicker(state, { ai: 'codex', model: 'custom', effort: '' }).value(), { ai: 'codex', model: 'custom', effort: '' });
  const picker = aiPicker(state, { ai: '人', model: '', effort: '' }, undefined, true);
  assert.deepEqual(picker.value(), { ai: '人', model: '', effort: '' });
  const [, model, effort] = controls(picker.node);
  assert.equal(model!.disabled, true); assert.equal(effort!.disabled, true);
});
