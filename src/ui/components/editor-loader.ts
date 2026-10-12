import type * as EditorModule from './files.ts';
import { run } from './dom.ts';
let modulePromise: Promise<typeof EditorModule> | undefined;
let moduleReady = false;
let mount: HTMLElement | undefined;
let scope: [string, string, string] = ['', '', ''];
export function mountEditorWorkbench(main: HTMLElement): void { mount = main; }
async function editor(): Promise<typeof EditorModule> {
  if (!modulePromise) modulePromise = import('./files.ts').then(module => { if (mount) module.mountEditorWorkbench(mount); module.setWorkbenchScope(...scope); moduleReady = true; return module; }).catch(error => { modulePromise = undefined; throw error; });
  return modulePromise;
}
export function setWorkbenchScope(project: string, task: string, workspace: string): void { scope = [project, task, workspace]; if (modulePromise) void run(async () => (await modulePromise!).setWorkbenchScope(...scope)); }
export function openFileBrowser(project: string, task: string, workspace?: string): void { void run(async () => (await editor()).openFileBrowser(project, task, workspace)); }
window.addEventListener('yumeewade:open-file', event => {
  if (moduleReady) return;
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return;
  const value = detail as Record<string, unknown>;
  if (typeof value.project !== 'string' || !value.project || typeof value.task !== 'string' || typeof value.path !== 'string' || !value.path || (value.line !== undefined && (!Number.isSafeInteger(value.line) || (value.line as number) < 1))) return;
  void run(async () => { await editor(); window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail })); });
});
