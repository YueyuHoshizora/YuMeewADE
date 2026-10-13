import type { EmbeddedPreviewState } from '../../shared/types.ts';
import type { WorkbenchPanelContext } from './files.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, el, field, input, row, run, setLocked, showError } from './dom.ts';

export function embeddedPreviewWorkbench(context: WorkbenchPanelContext): HTMLElement {
  // Collapsed below the editor until needed; it opens by itself when a preview is already running for this scope.
  const root = el('details', 'disclosure embedded-preview-panel');
  const command = input('node');
  const args = area('["server.mjs","--host","{host}","--port","{port}"]');
  const status = el('p');
  const url = input(); url.readOnly = true;
  const output = el('pre');
  const frame = document.createElement('iframe');
  frame.title = t('preview.title'); frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
  frame.style.width = '100%'; frame.style.minHeight = '420px'; frame.hidden = true;
  let current: EmbeddedPreviewState | undefined;
  let timer: number | undefined; let failing = false;
  let stopped = false;
  const scope = { project: context.project, task: context.task };
  const start = button(t('preview.start'), async () => {
    // Invalid JSON is the user's input, not a network failure: mark the field instead of showing a generic error.
    let parsed: unknown;
    try { parsed = JSON.parse(args.value); } catch { parsed = undefined; }
    if (!Array.isArray(parsed) || parsed.some(arg => typeof arg !== 'string')) { args.setCustomValidity(t('execution.argsInvalid')); args.reportValidity(); return; }
    args.setCustomValidity('');
    current = await request<EmbeddedPreviewState>('/api/embedded-preview/start', { ...scope, command: command.value, args: parsed });
    render(); poll();
  });
  const stop = button(t('preview.stop'), async () => {
    if (!current) return;
    await request('/api/embedded-preview/stop', { ...scope, id: current.id });
    current = await request<EmbeddedPreviewState>(query('/api/embedded-preview/status', { ...scope, id: current.id })); render();
  });
  const reload = button(t('preview.reload'), async () => {
    if (!current) return;
    current = await request<EmbeddedPreviewState>('/api/embedded-preview/reload', { ...scope, id: current.id });
    frame.src = current.url + '?__preview_reload=' + Date.now(); render();
  });
  const external = button(t('preview.external'), async () => {
    if (current) await request('/api/execution/preview', { ...scope, url: current.targetUrl });
  });
  function render(): void {
    status.textContent = current ? t(`preview.${current.state}`) : t('preview.idle');
    const active = current?.state === 'starting' || current?.state === 'running';
    setLocked(start, active); setLocked(stop, !active); setLocked(reload, current?.state !== 'running'); setLocked(external, current?.state !== 'running');
    command.disabled = active; args.disabled = active;
    // Status is polled every 700 ms; rewriting unchanged text would drop the reader's selection in the log.
    if (url.value !== (current?.url ?? '')) url.value = current?.url ?? '';
    if (output.textContent !== (current?.output ?? '')) output.textContent = current?.output ?? '';
    if (current?.state === 'running') { if (frame.hidden) frame.src = current.url; frame.hidden = false; }
    else { frame.hidden = true; frame.removeAttribute('src'); }
  }
  function poll(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    if (stopped || !current || !['starting', 'running'].includes(current.state)) return;
    timer = window.setTimeout(() => { void (async () => {
      if (!current || stopped || !root.isConnected) return;
      // A failed status request is reported once and polling continues, instead of freezing the panel on stale state.
      try { current = await request<EmbeddedPreviewState>(query('/api/embedded-preview/status', { ...scope, id: current.id })); failing = false; render(); }
      catch (error) { if (!failing) showError(error); failing = true; }
      finally { poll(); }
    })(); }, 700);
  }
  window.addEventListener('yumeewade:workspace-changed', () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); frame.removeAttribute('src'); }, { once: true });
  root.append(el('summary', '', t('preview.title')), el('p', 'warning', t('preview.security')), field(t('preview.command'), command), field(t('preview.args'), args), row(start, stop, reload, external), status, field(t('preview.url'), url), frame, output);
  render();
  void run(async () => { const views = await request<EmbeddedPreviewState[]>(query('/api/embedded-preview/list', scope)); if (stopped) return; current = views.find(view => ['starting', 'running'].includes(view.state)) ?? views.at(-1); if (current?.state === 'starting' || current?.state === 'running') root.open = true; render(); poll(); });
  return root;
}
