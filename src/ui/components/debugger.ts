import type { DebugAction, DebugSession, DebugValue, ExecutionRun } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, input, row, run } from './dom.ts';

export function embeddedDebugger(project: string, task: string, open?: (path: string, line: number) => void): { node: HTMLElement; attach: (run: string) => Promise<void>; dispose: () => void } {
  const node = el('section', 'card'); const controls = row(); const stack = el('div'); const variables = el('div'); const breakpoints = el('div'); const scripts = el('datalist'); scripts.id = `debug-scripts-${crypto.randomUUID()}`;
  const file = input(); file.setAttribute('list', scripts.id); const line = input('1'); line.type = 'number'; line.min = '1';
  const condition = input(); const watch = input(); const watchResult = el('code');
  const status = el('p'); let session: DebugSession | undefined; let alive = true; let timer: number | undefined;
  const ids = () => ({ project, task, id: session!.id, revision: session!.revision });
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
      const source = frame.location.source; const target = source?.path ?? script?.path; const targetLine = source?.line ?? frame.location.line;
      const item = el('section'); const label = `${frame.name || '—'} · ${target || frame.url} : ${targetLine}`;
      item.append(target && open ? button(label, () => open(target, targetLine)) : el('code', '', label));
      for (const scope of frame.scopes) if (scope.objectId) item.append(button(`${t('tools.variables')} · ${scope.name || scope.type}`, () => showVariables(scope.objectId!)));
      return item;
    }));
    breakpoints.replaceChildren(...session.breakpoints.map(point => row(el('code', '', `${point.path}:${point.line}${point.condition ? ` · ${point.condition}` : ''}`), button(t('common.remove'), async () => { session = await request<DebugSession>('/api/debugger/source-breakpoint/delete', { ...ids(), breakpoint: point.id }); render(); }))));
    scripts.replaceChildren(...session.scripts.flatMap(script => [script.path, ...(script.sources ?? [])]).map(path => { const option = el('option'); option.value = path; return option; }));
    const top = session.frames[0]; const topScript = top && session.scripts.find(s => s.id === top.location.scriptId);
    window.dispatchEvent(new CustomEvent('yumeewade:debug-decoration', { detail: { project, task, run: session.run, breakpoints: session.breakpoints.map(({ path, line }) => ({ path, line })), ...(top?.location.source ? { active: top.location.source } : topScript && top ? { active: { path: topScript.path, line: top.location.line } } : {}) } }));
    for (const control of controls.querySelectorAll<HTMLButtonElement>('button[data-action]')) control.disabled = control.dataset.action === 'pause' ? session.status !== 'running' : session.status !== 'paused';
    if (session.status !== 'paused') variables.replaceChildren();
  }
  async function poll(): Promise<void> {
    if (!alive || !session) return;
    try { session = await request<DebugSession>(query('/api/debugger/state', { project, task, id: session.id })); render(); }
    finally { if (alive && session && !['closed', 'failed'].includes(session.status)) timer = window.setTimeout(() => { void run(poll); }, 250); }
  }
  const actions: { action: DebugAction; label: 'tools.pause' | 'tools.resume' | 'tools.stepOver' | 'tools.stepInto' | 'tools.stepOut' }[] = [{ action: 'pause', label: 'tools.pause' }, { action: 'resume', label: 'tools.resume' }, { action: 'stepOver', label: 'tools.stepOver' }, { action: 'stepInto', label: 'tools.stepInto' }, { action: 'stepOut', label: 'tools.stepOut' }];
  for (const action of actions) { const control = button(t(action.label), async () => { if (!session) return; session = await request<DebugSession>('/api/debugger/action', { ...ids(), action: action.action }); render(); }); control.dataset.action = action.action; control.disabled = true; controls.append(control); }
  node.append(el('h3', '', t('tools.debugger')), el('p', '', t('debug.sourceMaps')), status, controls, field(t('tools.breakpointFile'), file), field(t('tools.breakpointLine'), line), field(t('debug.condition'), condition), el('p', '', t('debug.risk')), button(t('tools.breakpoint'), async () => { if (!session) return; session = await request<DebugSession>('/api/debugger/source-breakpoint', { ...ids(), path: file.value, line: Number(line.value), condition: condition.value }); render(); }), scripts, breakpoints, stack, variables, field(t('debug.watch'), watch), el('p', '', t('debug.watchGrammar')), button(t('debug.watch'), async () => {
    if (!session?.frames[0]) return;
    const value = await request<DebugValue>('/api/debugger/watch', { ...ids(), frame: session.frames[0].id, expression: watch.value });
    if (alive) watchResult.textContent = `${value.name}: ${value.value || value.type}`;
  }), watchResult);
  const gutter = (event: Event): void => {
    const detail: unknown = (event as CustomEvent).detail;
    if (!detail || typeof detail !== 'object') return;
    const value = detail as Record<string, unknown>;
    if (!alive || !node.isConnected || !session || value.project !== project || value.task !== task || typeof value.path !== 'string' || !Number.isSafeInteger(value.line) || (value.run !== undefined && value.run !== session.run) || ['closed', 'failed'].includes(session.status)) return;
    const point = session.breakpoints.find(p => p.path === value.path && p.line === value.line);
    void run(async () => {
      const current = session!;
      const next = point ? await request<DebugSession>('/api/debugger/source-breakpoint/delete', { project, task, id: current.id, revision: current.revision, breakpoint: point.id }) : await request<DebugSession>('/api/debugger/source-breakpoint', { project, task, id: current.id, revision: current.revision, path: value.path, line: value.line });
      if (alive && session?.id === current.id) { session = next; render(); }
    });
  };
  window.addEventListener('yumeewade:debug-gutter', gutter);
  async function attach(run: string): Promise<void> {
    if (session) await request('/api/debugger/detach', ids());
    clearTimeout(timer); session = await request<DebugSession>('/api/debugger/attach', { project, task, run });
    if (!alive) { await request('/api/debugger/detach', ids()); return; }
    await poll();
  }
  function dispose(): void { alive = false; clearTimeout(timer); window.removeEventListener('yumeewade:debug-gutter', gutter); window.dispatchEvent(new CustomEvent('yumeewade:debug-decoration', { detail: { project, task, run: session?.run, breakpoints: [] } })); if (session) void request('/api/debugger/detach', ids()).catch(() => undefined); }
  return { node, attach, dispose };
}

export function debuggerWorkbench(context: { project: string; task: string; open: (path: string, line: number) => void }): HTMLElement {
  const panel = embeddedDebugger(context.project, context.task, context.open);
  const runs = el('select'); const node = el('section');
  async function refresh(): Promise<void> {
    const list = await request<ExecutionRun[]>(query('/api/execution/list', { project: context.project, task: context.task }));
    runs.replaceChildren(...list.filter(r => r.kind === 'debug' && r.status === 'running').map(r => { const option = el('option'); option.value = r.id; option.textContent = `${r.command} · ${r.id}`; return option; }));
  }
  node.append(field(t('debug.run'), runs), button(t('debug.refresh'), refresh), button(t('debug.attach'), async () => { if (runs.value) await panel.attach(runs.value); }), panel.node);
  const observer = new MutationObserver(() => { if (!node.isConnected) { observer.disconnect(); panel.dispose(); } });
  queueMicrotask(() => { if (node.isConnected) observer.observe(document.body, { childList: true, subtree: true }); });
  void run(refresh);
  return node;
}
