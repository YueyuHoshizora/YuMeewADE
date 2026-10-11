import type { ExecutionRun, ExecutionRequest, RunConfiguration } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, el, field, input, row, run, select, type ViewContext } from './dom.ts';
import { embeddedTerminal } from './terminal.ts';
import { embeddedDebugger } from './debugger.ts';

export function executionButton(_context: ViewContext, project: string, task: string): HTMLElement {
  return button(t('execution.title'), () => {
    const dialog = el('dialog', 'modal');
    const executable = input('node');
    const args = area('["--version"]');
    const preview = input('http://127.0.0.1:3000');
    const terminal = input('');
    const inspector = input('');
    const output = el('div');
    const cwd = input('');
    const env = area('{}');
    const configName = input('');
    const configKind = select([{ value: 'command', label: t('execution.start') }, { value: 'preview', label: t('execution.background') }, { value: 'debug', label: t('execution.debug') }], 'command');
    const configList = select([]);
    let configurations: RunConfiguration[] = [];
    const embedded = embeddedTerminal(project, task);
    const debuggerPanel = embeddedDebugger(project, task);
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
          if (entry.kind === 'debug' && entry.status === 'running') controls.append(button(t('tools.debugger'), () => debuggerPanel.attach(entry.id)));
          section.append(controls, el('pre', 'verify-output', entry.output.map(event => `[${event.stream}] ${event.text}`).join('')));
          if (entry.truncated) section.append(el('p', 'warning', t('execution.truncated')));
          if (entry.timedOut) section.append(el('p', 'warning', t('execution.timedOut')));
          return section;
        }));
      } finally { if (alive) timer = window.setTimeout(() => { void run(poll); }, 500); }
    }
    function executionRequest(kind: ExecutionRequest['kind']): ExecutionRequest | undefined {
      let argv: unknown; let overrides: unknown;
      try { argv = JSON.parse(args.value); overrides = JSON.parse(env.value); }
      catch { args.setCustomValidity(t('execution.argsInvalid')); args.reportValidity(); return; }
      if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string') || !overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.values(overrides).some(value => typeof value !== 'string')) { args.setCustomValidity(t('execution.argsInvalid')); args.reportValidity(); return; }
      args.setCustomValidity('');
      return { command: kind === 'debug' ? 'node' : executable.value, args: argv as string[], env: overrides as Record<string, string>, ...(cwd.value ? { cwd: cwd.value } : {}), ...(kind ? { kind } : {}) };
    }
    async function start(kind: ExecutionRequest['kind']): Promise<void> {
      const spec = executionRequest(kind); if (!spec) return;
      const entry = await request<ExecutionRun>('/api/execution/start', { ...ids, ...spec });
      if (entry.kind === 'debug') await debuggerPanel.attach(entry.id);
    }
    async function loadConfigurations(): Promise<void> {
      configurations = await request<RunConfiguration[]>(query('/api/execution/configs', ids));
      if (!alive) return;
      configList.replaceChildren(...configurations.map(config => { const option = el('option', '', config.name); option.value = config.name; return option; }));
    }
    function loadSelected(): void {
      const config = configurations.find(c => c.name === configList.value); if (!config) return;
      configName.value = config.name; executable.value = config.command; args.value = JSON.stringify(config.args); cwd.value = config.cwd; env.value = JSON.stringify(config.env); configKind.value = config.kind;
    }
    dialog.append(row(el('h2', '', t('execution.title')), button(t('common.close'), () => dialog.close())),
      el('p', '', t('tools.notice')),
      field(t('execution.command'), executable), field(t('execution.args'), args),
      field(t('tools.cwd'), cwd), field(t('tools.env'), env), el('p', '', t('tools.envHint')),
      field(t('tools.configs'), configList), field(t('tools.configName'), configName), field(t('tools.configKind'), configKind),
      row(button(t('tools.configLoad'), loadSelected), button(t('common.save'), async () => {
        const spec = executionRequest(configKind.value as NonNullable<ExecutionRequest['kind']>); if (!spec) return;
        await request('/api/execution/config/save', { ...ids, config: { ...spec, name: configName.value, cwd: cwd.value } }); await loadConfigurations();
      }), button(t('tools.configRun'), async () => { const entry = await request<ExecutionRun>('/api/execution/config/run', { ...ids, name: configList.value }); if (entry.kind === 'debug') await debuggerPanel.attach(entry.id); }), button(t('common.remove'), async () => { await request('/api/execution/config/delete', { ...ids, name: configList.value }); await loadConfigurations(); })),
      row(button(t('execution.start'), () => start('command')), button(t('execution.background'), () => start('preview')), button(t('execution.debug'), () => start('debug'))),
      field(t('execution.previewUrl'), preview), button(t('execution.preview'), () => request('/api/execution/preview', { ...ids, url: preview.value })),
      row(button(t('execution.ide'), () => request('/api/execution/ide', ids))),
      field(t('execution.terminalCommand'), terminal), button(t('execution.terminal'), () => request('/api/execution/terminal', { ...ids, command: terminal.value })),
      field(t('execution.inspector'), inspector), row(button(t('execution.attach'), () => request('/api/execution/debug', { ...ids, url: inspector.value })), button(t('execution.attachIde'), () => request('/api/execution/debug', { ...ids, url: inspector.value, target: 'ide' }))),
      embedded.node, debuggerPanel.node, output);
    dialog.addEventListener('close', () => { alive = false; clearTimeout(timer); embedded.dispose(); debuggerPanel.dispose(); dialog.remove(); }, { once: true });
    document.body.append(dialog); dialog.showModal(); void run(poll); void run(loadConfigurations);
  });
}
