import type { DebugAction, DebugSession, DebugValue } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, input, row, run } from './dom.ts';

export function embeddedDebugger(project: string, task: string): { node: HTMLElement; attach: (run: string) => Promise<void>; dispose: () => void } {
  const node = el('section', 'card'); const controls = row(); const stack = el('div'); const variables = el('div'); const breakpoints = el('div'); const scripts = el('datalist'); scripts.id = `debug-scripts-${crypto.randomUUID()}`;
  const file = input(); file.setAttribute('list', scripts.id); const line = input('1'); line.type = 'number'; line.min = '1';
  const status = el('p'); let session: DebugSession | undefined; let alive = true; let timer: number | undefined;
  const ids = () => ({ project, task, id: session!.id });
  async function showVariables(object: string): Promise<void> {
    const values = await request<DebugValue[]>('/api/debugger/variables', { ...ids(), object });
    if (!alive) return;
    variables.replaceChildren(el('h4', '', t('tools.variables')), ...values.map(value => {
      const item = row(el('code', '', `${value.name}: ${value.value || value.type}`));
      if (value.objectId) item.append(button(t('tools.expand'), () => showVariables(value.objectId!)));
      return item;
    }));
  }
  function render(): void {
    if (!session || !alive) return;
    status.textContent = `${t(session.status === 'paused' ? 'tools.paused' : session.status === 'running' ? 'tools.running' : session.status === 'connecting' ? 'tools.connecting' : 'tools.closed')} · ${session.reason}`;
    stack.replaceChildren(el('h4', '', t('tools.stack')), ...session.frames.map(frame => {
      const script = session!.scripts.find(s => s.id === frame.location.scriptId);
      const item = el('section'); item.append(el('code', '', `${frame.name || '—'} · ${script?.path || frame.url} : ${frame.location.line}`));
      for (const scope of frame.scopes) if (scope.objectId) item.append(button(`${t('tools.variables')} · ${scope.name || scope.type}`, () => showVariables(scope.objectId!)));
      return item;
    }));
    breakpoints.replaceChildren(...session.breakpoints.map(point => row(el('code', '', `${point.path}:${point.line}`), button(t('common.remove'), async () => { session = await request<DebugSession>('/api/debugger/breakpoint/delete', { ...ids(), breakpoint: point.id }); render(); }))));
    scripts.replaceChildren(...session.scripts.map(script => { const option = el('option'); option.value = script.path; return option; }));
    for (const control of controls.querySelectorAll<HTMLButtonElement>('button[data-action]')) control.disabled = control.dataset.action === 'pause' ? session.status !== 'running' : session.status !== 'paused';
    if (session.status !== 'paused') variables.replaceChildren();
  }
  async function poll(): Promise<void> {
    if (!alive || !session) return;
    try { session = await request<DebugSession>(query('/api/debugger/state', ids())); render(); }
    finally { if (alive && session && !['closed', 'failed'].includes(session.status)) timer = window.setTimeout(() => { void run(poll); }, 250); }
  }
  const actions: { action: DebugAction; label: 'tools.pause' | 'tools.resume' | 'tools.stepOver' | 'tools.stepInto' | 'tools.stepOut' }[] = [{ action: 'pause', label: 'tools.pause' }, { action: 'resume', label: 'tools.resume' }, { action: 'stepOver', label: 'tools.stepOver' }, { action: 'stepInto', label: 'tools.stepInto' }, { action: 'stepOut', label: 'tools.stepOut' }];
  for (const action of actions) { const control = button(t(action.label), async () => { if (!session) return; session = await request<DebugSession>('/api/debugger/action', { ...ids(), action: action.action }); render(); }); control.dataset.action = action.action; control.disabled = true; controls.append(control); }
  node.append(el('h3', '', t('tools.debugger')), status, controls, field(t('tools.breakpointFile'), file), field(t('tools.breakpointLine'), line), button(t('tools.breakpoint'), async () => { if (!session) return; session = await request<DebugSession>('/api/debugger/breakpoint', { ...ids(), path: file.value, line: Number(line.value) }); render(); }), scripts, breakpoints, stack, variables);
  async function attach(run: string): Promise<void> {
    if (session) await request('/api/debugger/detach', ids());
    clearTimeout(timer); session = await request<DebugSession>('/api/debugger/attach', { project, task, run });
    if (!alive) { await request('/api/debugger/detach', ids()); return; }
    await poll();
  }
  function dispose(): void { alive = false; clearTimeout(timer); if (session) void request('/api/debugger/detach', ids()).catch(() => undefined); }
  return { node, attach, dispose };
}
