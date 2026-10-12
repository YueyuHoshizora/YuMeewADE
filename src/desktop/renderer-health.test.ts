import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

// Electron is replaced by a tiny stand-in: this file runs in its own process, so the hook affects nothing else.
const dir = mkdtempSync(path.join(os.tmpdir(), 'renderer-health-'));
const prompts: { buttons: string[]; resolve: (value: { response: number }) => void }[] = [];
let reloads = 0;
Object.assign(globalThis, { __rendererHealthElectron: {
  app: { getPath: () => dir, getLocale: () => 'en', quit: () => undefined },
  dialog: { showMessageBox: (_win: unknown, options: { buttons: string[] }) => { const { promise, resolve } = Promise.withResolvers<{ response: number }>(); prompts.push({ buttons: options.buttons, resolve }); return promise; } },
} });
const stand = 'data:text/javascript,' + encodeURIComponent('export const app = globalThis.__rendererHealthElectron.app; export const dialog = globalThis.__rendererHealthElectron.dialog;');
registerHooks({ resolve: (specifier, context, next) => specifier === 'electron' ? { url: stand, shortCircuit: true } : next(specifier, context) });
const { monitorRenderer } = await import('./renderer-health.ts');

test('a crash while the hang dialog is open is offered for recovery once that dialog closes', async t => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const win = Object.assign(new EventEmitter(), { id: 1, webContents: new EventEmitter(), isDestroyed: () => false, reload: () => { reloads++; } });
  monitorRenderer(win as unknown as BrowserWindow, () => false);
  win.emit('unresponsive');
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
  assert.equal(prompts.length, 1, 'only one dialog at a time');
  prompts[0]!.resolve({ response: 0 }); // Wait
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts.length, 2);
  prompts[1]!.resolve({ response: 0 }); // Reload
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloads, 1);
});
