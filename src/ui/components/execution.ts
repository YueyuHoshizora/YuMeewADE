import type { ExecutionRun, ExecutionRequest } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, el, field, input, row, run, type ViewContext } from './dom.ts';

export function executionButton(_context: ViewContext, project: string, task: string): HTMLElement {
  return button(t('execution.title'), () => {
    const dialog = el('dialog', 'modal');
    const executable = input('node');
    const args = area('["--version"]');
    const preview = input('http://127.0.0.1:3000');
    const terminal = input('');
    const inspector = input('');
    const output = el('div');
    let alive = true;
    let timer: number | undefined;
    const ids = { project, task };
    async function poll(): Promise<void> {
      if (!alive) return;
      try {
        const runs = await request<ExecutionRun[]>(query('/api/execution/list', ids));
        if (!alive) return;
        output.replaceChildren(...runs.map(entry => {
          const section = el('section', 'card');
          const controls = row(el('strong', '', `${entry.kind} · ${entry.command} · ${entry.status} · ${entry.exitCode ?? ''}`));
          if (entry.status === 'running') controls.append(button(t('execution.stop'), async () => { await request('/api/execution/stop', { ...ids, id: entry.id }); }));
          if (entry.inspectorUrl) controls.append(button(t('execution.attach'), () => request('/api/execution/debug', { ...ids, url: entry.inspectorUrl })));
          section.append(controls, el('pre', 'verify-output', entry.output.map(event => `[${event.stream}] ${event.text}`).join('')));
          if (entry.truncated) section.append(el('p', 'warning', t('execution.truncated')));
          if (entry.timedOut) section.append(el('p', 'warning', t('execution.timedOut')));
          return section;
        }));
      } finally { if (alive) timer = window.setTimeout(() => { void run(poll); }, 500); }
    }
    async function start(kind: ExecutionRequest['kind']): Promise<void> {
      let argv: unknown;
      try { argv = JSON.parse(args.value); } catch { args.setCustomValidity(t('execution.argsInvalid')); args.reportValidity(); return; }
      if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) { args.setCustomValidity(t('execution.argsInvalid')); args.reportValidity(); return; }
      args.setCustomValidity('');
      await request('/api/execution/start', { ...ids, command: kind === 'debug' ? 'node' : executable.value, args: argv, kind });
    }
    dialog.append(row(el('h2', '', t('execution.title')), button(t('common.close'), () => dialog.close())),
      el('p', '', t('execution.notice')),
      field(t('execution.command'), executable), field(t('execution.args'), args),
      row(button(t('execution.start'), () => start('command')), button(t('execution.background'), () => start('preview')), button(t('execution.debug'), () => start('debug'))),
      field(t('execution.previewUrl'), preview), button(t('execution.preview'), () => request('/api/execution/preview', { ...ids, url: preview.value })),
      row(button(t('execution.ide'), () => request('/api/execution/ide', ids))),
      field(t('execution.terminalCommand'), terminal), button(t('execution.terminal'), () => request('/api/execution/terminal', { ...ids, command: terminal.value })),
      field(t('execution.inspector'), inspector), row(button(t('execution.attach'), () => request('/api/execution/debug', { ...ids, url: inspector.value })), button(t('execution.attachIde'), () => request('/api/execution/debug', { ...ids, url: inspector.value, target: 'ide' }))),
      output);
    dialog.addEventListener('close', () => { alive = false; clearTimeout(timer); dialog.remove(); }, { once: true });
    document.body.append(dialog); dialog.showModal(); void run(poll);
  });
}
