import type { DebugAction, DebugSession, DebugValue, ExecutionRun, DapLaunch, DapSession } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { labelValue, t } from '../i18n/index.ts';
import { button, el, field, input, row, run, setLocked, UserError } from './dom.ts';

export function embeddedDebugger(project: string, task: string, open?: (path: string, line: number) => void): { node: HTMLElement; attach: (run: string) => Promise<void>; launch: (config: DapLaunch) => Promise<void>; dispose: () => void } {
  const node = el('section', 'card'); const controls = row(); const stack = el('div'); const variables = el('div'); const breakpoints = el('div'); const scripts = el('datalist'); scripts.id = `debug-scripts-${crypto.randomUUID()}`;
  const file = input(); file.setAttribute('list', scripts.id); const line = input('1'); line.type = 'number'; line.min = '1';
  const condition = input(); const watch = input(); const watchResult = el('code');
  const risk = el('p', '', t('debug.risk')); const watchHelp = el('p', '', t('debug.watchGrammar'));
  const status = el('p'); const capabilities = el('p'); let session: DebugSession | DapSession | undefined; let alive = true; let timer: number | undefined;
  let sessionEpoch = 0;
  const ids = () => ({ project, task, id: session!.id, revision: session!.revision });
  let valueEpoch = 0; let variablesRequest = 0; let valueContext = '';
  function clearValues(): void { valueEpoch++; variables.replaceChildren(); watchResult.textContent = ''; }
  async function showVariables(object: string): Promise<void> {
    const epoch = valueEpoch; const serial = ++variablesRequest;
    const values = await request<DebugValue[]>('/api/debugger/variables', { ...ids(), object });
    if (!alive || epoch !== valueEpoch || serial !== variablesRequest) return;
    variables.replaceChildren(el('h4', '', t('tools.variables')), ...values.map(value => {
      const item = row(el('code', '', `${value.name}: ${value.value || value.type}`));
      if (value.objectId) item.append(button(t('tools.expand'), () => showVariables(value.objectId!)));
      return item;
    }));
  }
  let renderedSession = '';
  function render(): void {
    if (!session || !alive) return;
    const snapshot = JSON.stringify(session);
    if (snapshot === renderedSession) return;
    renderedSession = snapshot;
    const context = JSON.stringify([session.id, session.status, session.frames]);
    if (context !== valueContext) { valueContext = context; clearValues(); }
    status.textContent = `${t(session.status === 'paused' ? 'tools.paused' : session.status === 'running' ? 'tools.running' : session.status === 'connecting' ? 'tools.connecting' : 'tools.closed')} · ${session.reason}`;
    const dap = session && 'protocol' in session ? session as DapSession : undefined;
    capabilities.textContent = dap ? `${t('dap.capabilities')} · ${labelValue(t('dap.conditional'), t(dap.capabilities.conditionalBreakpoints ? 'dap.supported' : 'dap.unsupported'))} · ${labelValue(t('dap.evaluate'), t(dap.capabilities.evaluate ? 'dap.supported' : 'dap.unsupported'))}${dap.diagnostic ? ` · ${t('dap.failure', { reason: t(`dap.${dap.diagnostic}`) })}` : ''}` : '';
    condition.disabled = Boolean(dap && !dap.capabilities.conditionalBreakpoints);
    watch.disabled = Boolean(dap && !dap.capabilities.evaluate);
    risk.textContent = t(dap ? 'dap.expressionRisk' : 'debug.risk');
    watchHelp.textContent = t(dap ? 'dap.expressionRisk' : 'debug.watchGrammar');
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
    for (const control of controls.querySelectorAll<HTMLButtonElement>('button[data-action]')) setLocked(control, control.dataset.action === 'pause' ? session.status !== 'running' : session.status !== 'paused');
    const live = !['closed', 'failed'].includes(session.status);
    setLocked(addBreakpoint, !live); setLocked(detach, !live); setLocked(watchButton, !live || session.status !== 'paused' || watch.disabled);
  }
  async function poll(): Promise<void> {
    if (!alive || !session) return;
    const epoch = sessionEpoch; const id = session.id;
    try {
      const next = await request<DebugSession>(query('/api/debugger/state', { project, task, id }));
      if (!alive || epoch !== sessionEpoch || session?.id !== id) return;
      session = next; render();
    } finally {
      if (alive && epoch === sessionEpoch && session?.id === id && !['closed', 'failed'].includes(session.status)) timer = window.setTimeout(() => { void run(poll); }, 250);
    }
  }
  const actions: { action: DebugAction; label: 'tools.pause' | 'tools.resume' | 'tools.stepOver' | 'tools.stepInto' | 'tools.stepOut' }[] = [{ action: 'pause', label: 'tools.pause' }, { action: 'resume', label: 'tools.resume' }, { action: 'stepOver', label: 'tools.stepOver' }, { action: 'stepInto', label: 'tools.stepInto' }, { action: 'stepOut', label: 'tools.stepOut' }];
  for (const action of actions) { const control = button(t(action.label), async () => { if (!session) return; clearValues(); session = await request<DebugSession>('/api/debugger/action', { ...ids(), action: action.action }); render(); }); control.dataset.action = action.action; setLocked(control, true); controls.append(control); }
  // Session-bound actions stay disabled until render() sees a live session, instead of silently doing nothing.
  const addBreakpoint = button(t('tools.breakpoint'), async () => { if (!session) return; session = await request<DebugSession>('/api/debugger/source-breakpoint', { ...ids(), path: file.value, line: Number(line.value), condition: condition.value }); render(); });
  const watchButton = button(t('debug.watch'), async () => {
    if (!session?.frames[0]) return;
    const epoch = valueEpoch;
    const value = await request<DebugValue>('/api/debugger/watch', { ...ids(), frame: session.frames[0].id, expression: watch.value });
    if (alive && epoch === valueEpoch) watchResult.textContent = `${value.name}: ${value.value || value.type}`;
  });
  const detach = button(t('dap.stop'), async () => { if (!session) return; sessionEpoch++; clearTimeout(timer); clearValues(); await request('/api/debugger/detach', ids()); await poll(); });
  for (const control of [addBreakpoint, watchButton, detach]) setLocked(control, true);
  node.append(el('h3', '', t('tools.debugger')), el('p', '', t('debug.sourceMaps')), status, controls, field(t('tools.breakpointFile'), file), field(t('tools.breakpointLine'), line), field(t('debug.condition'), condition), risk, addBreakpoint, scripts, breakpoints, stack, variables, field(t('debug.watch'), watch), watchHelp, watchButton, watchResult);
  node.append(capabilities, detach);
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
    sessionEpoch++; clearTimeout(timer); clearValues();
    if (session) await request('/api/debugger/detach', ids());
    session = await request<DebugSession>('/api/debugger/attach', { project, task, run });
    if (!alive) { await request('/api/debugger/detach', ids()); return; }
    await poll();
  }
  async function launch(config: DapLaunch): Promise<void> {
    sessionEpoch++; clearTimeout(timer); clearValues();
    if (session) await request('/api/debugger/detach', ids());
    session = await request<DapSession>('/api/debugger/dap/launch', { project, task, launch: config });
    if (!alive) { await request('/api/debugger/detach', ids()); return; }
    await poll();
  }
  function dispose(): void { alive = false; clearTimeout(timer); window.removeEventListener('yumeewade:debug-gutter', gutter); window.dispatchEvent(new CustomEvent('yumeewade:debug-decoration', { detail: { project, task, run: session?.run, breakpoints: [] } })); if (session) void request('/api/debugger/detach', ids()).catch(() => undefined); }
  return { node, attach, launch, dispose };
}

export function debuggerWorkbench(context: { project: string; task: string; open: (path: string, line: number) => void }): HTMLElement {
  const panel = embeddedDebugger(context.project, context.task, context.open);
  const runs = el('select'); const node = el('section');
  const attach = button(t('debug.attach'), async () => { if (runs.value) await panel.attach(runs.value); });
  async function refresh(): Promise<void> {
    const list = await request<ExecutionRun[]>(query('/api/execution/list', { project: context.project, task: context.task }));
    runs.replaceChildren(...list.filter(r => r.kind === 'debug' && r.status === 'running').map(r => { const option = el('option'); option.value = r.id; option.textContent = `${r.command} · ${r.id}`; return option; }));
    setLocked(attach, !runs.options.length);
  }
  const adapter = input(); const program = input(); const args = input('[]'); const launchBreakpoints = input('[]'); const stop = input(); stop.type = 'checkbox'; stop.checked = true;
  const type = el('select'); for (const value of ['python', 'lldb']) { const option = el('option'); option.value = value; option.textContent = value === 'python' ? 'Python / debugpy' : 'LLDB'; type.append(option); }
  const saved = el('select'); const name = input(); name.required = true;
  const storageKey = `yumeewade.dap.${context.project}.${context.task}`;
  let configurations: Record<string, DapLaunch> = {};
  try { const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configurations = parsed as Record<string, DapLaunch>; } catch { /* Invalid local preferences are discarded, never launched. */ }
  const save = button(t('common.save'), () => {
    if (!name.value.trim()) { name.value = ''; name.reportValidity(); return; }
    configurations[name.value.trim()] = configuration(); localStorage.setItem(storageKey, JSON.stringify(configurations)); refreshConfigurations();
  });
  const choose = button(t('dap.choose'), () => { const config = configurations[saved.value]; if (!config) return; adapter.value = JSON.stringify(config.adapter); type.value = config.type; program.value = config.program; args.value = JSON.stringify(config.args ?? []); launchBreakpoints.value = JSON.stringify(config.breakpoints ?? []); stop.checked = config.stopOnEntry ?? true; });
  const remove = button(t('common.remove'), () => { delete configurations[saved.value]; localStorage.setItem(storageKey, JSON.stringify(configurations)); refreshConfigurations(); });
  function refreshConfigurations(): void {
    saved.replaceChildren(...Object.keys(configurations).map(key => { const option = el('option'); option.value = key; option.textContent = key; return option; }));
    setLocked(choose, !saved.options.length); setLocked(remove, !saved.options.length);
  }
  // Each JSON field is checked on its own, so a typo is marked on that field instead of surfacing as a network error.
  function json<T>(node: HTMLInputElement, valid: (value: unknown) => boolean, message: string): T {
    let value: unknown; try { value = JSON.parse(node.value); } catch { value = undefined; }
    if (!valid(value)) { node.setCustomValidity(message); node.reportValidity(); throw new UserError(message); }
    node.setCustomValidity(''); return value as T;
  }
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  const points = (value: unknown) => Array.isArray(value) && value.every(item => !!item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' && Number.isSafeInteger((item as { line?: unknown }).line) && ['undefined', 'string'].includes(typeof (item as { condition?: unknown }).condition));
  function configuration(): DapLaunch {
    return { adapter: json<string[]>(adapter, value => strings(value) && (value as string[]).length > 0, t('execution.argsInvalid')), type: type.value, program: program.value, args: json<string[]>(args, strings, t('execution.argsInvalid')), breakpoints: json<NonNullable<DapLaunch['breakpoints']>>(launchBreakpoints, points, t('dap.breakpointsInvalid')), stopOnEntry: stop.checked };
  }
  refreshConfigurations();
  node.append(el('h3', '', t('dap.title')), el('p', '', t('dap.install')), field(t('dap.type'), type), field(t('dap.adapter'), adapter), el('p', '', t('dap.examples')), field(t('dap.program'), program), field(t('dap.args'), args), field(t('dap.initialBreakpoints'), launchBreakpoints), field(t('dap.stopOnEntry'), stop), field(t('dap.name'), name), save, field(t('dap.saved'), saved), choose, remove, button(t('dap.launch'), () => panel.launch(configuration())));
  node.append(field(t('debug.run'), runs), button(t('debug.refresh'), refresh), attach, panel.node);
  const observer = new MutationObserver(() => { if (!node.isConnected) { observer.disconnect(); panel.dispose(); } });
  queueMicrotask(() => { if (node.isConnected) observer.observe(document.body, { childList: true, subtree: true }); });
  void run(refresh);
  return node;
}
