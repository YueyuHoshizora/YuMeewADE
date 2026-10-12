import type { TestCaseNode, TestExplorerRun, TestExplorerState, VerificationHistoryEntry } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, input, modal, row, select } from './dom.ts';

export function testExplorerButton(project: string, task: string): HTMLElement {
  return button(t('tests.title'), async () => {
    const scope = { project, task };
    const list = el('div', 'form');
    const configuration = input('Node'); configuration.maxLength = 80;
    // An example path is a hint, not a default: saving it would configure a file that does not exist.
    const files = input('', 'test/example.test.ts'); files.maxLength = 16000;
    const framework = select((['node', 'vitest', 'jest', 'pytest', 'go'] as const).map(value => ({ value, label: t(`tests.framework.${value}`) })), 'node');
    const configFile = input(); configFile.maxLength = 4096;
    let revision = '';
    // The run request only resolves when the runner exits; show that it is alive and how long it has been going.
    const status = el('p', 'muted'); status.setAttribute('role', 'status');
    let active = false;
    const render = async () => {
      const state = await request<TestExplorerState>(query('/api/task/tests', scope));
      revision = state.revision;
      list.replaceChildren();
      const run = async (runner: string, selection?: string) => {
        if (active) return;
        active = true;
        const started = Date.now();
        const tick = () => { status.textContent = t('tests.running', { name: selection ? `${runner} · ${selection}` : runner, seconds: String(Math.floor((Date.now() - started) / 1000)) }); };
        tick();
        const timer = window.setInterval(tick, 1000);
        try { await request<TestExplorerRun>('/api/task/tests/run', { ...scope, runner, ...(selection ? { selection } : {}) }); }
        finally { window.clearInterval(timer); status.textContent = ''; active = false; }
        await render();
      };
      for (const config of state.configurations) list.append(row(el('code', '', `${config.name} · ${t(`tests.framework.${config.framework ?? 'node'}`)}`), button(t('tests.discover'), () => run(config.name)), button(t('tests.editConfig'), () => { configuration.value = config.name; framework.value = config.framework ?? 'node'; configFile.value = config.config ?? ''; files.value = config.files.join(', '); })));
      const latest = state.history.at(-1);
      if (latest) {
        const previous = state.history.slice(0, -1).reverse().find(item => item.runner === latest.runner && item.selection === latest.selection);
        const prior = new Map<string, TestCaseNode>();
        const collect = (nodes: TestCaseNode[]) => { for (const node of nodes) { prior.set(node.fullName, node); collect(node.children); } };
        if (previous) collect(previous.tree);
        const tree = (nodes: TestCaseNode[]): HTMLElement => {
          const group = el('ul');
          for (const node of nodes) {
            const item = el('li');
            const old = prior.get(node.fullName);
            item.append(el('span', '', `${node.name}: ${t(`tests.${node.status}`)}${old && old.status !== node.status ? ` (${t(`tests.${old.status}`)} → ${t(`tests.${node.status}`)})` : ''}`));
            item.append(button(t('tests.rerun'), () => run(latest.runner, node.fullName)));
            if (node.file) item.append(button(`${node.file}:${node.line ?? 1}`, () => window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail: { ...scope, path: node.file, line: node.line ?? 1 } }))));
            if (node.error) item.append(el('pre', '', node.error));
            if (node.children.length) item.append(tree(node.children));
            group.append(item);
          }
          return group;
        };
        list.append(el('p', 'muted', latest.at), tree(latest.tree));
        if (latest.treeTruncated) list.append(el('p', 'muted', t('tests.treeTruncated', { n: 2000 })));
        list.append(el('pre', '', latest.result.output));
        if (latest.result.truncated) list.append(el('p', 'muted', t('tests.truncated')));
      }
      if (!state.history.length) return;
      const history = select(state.history.map(run => ({ value: run.id, label: `${run.at} · ${run.runner} · ${t(run.result.ok ? 'tests.passed' : 'tests.failed')}` })), latest?.id ?? '');
      // The latest run's output is already shown above; this box only holds an explicitly chosen older run.
      const output = el('pre'); output.hidden = true;
      history.onchange = () => { const selected = state.history.find(run => run.id === history.value); output.textContent = selected?.result.output ?? ''; output.hidden = !output.textContent; };
      list.append(field(t('tests.history'), history), output);
    };
    await render();
    modal(t('tests.title'), el('p', 'muted', t('tests.frameworkHint')), field(t('tests.name'), configuration), field(t('tests.framework'), framework), field(t('tests.configFile'), configFile), field(t('tests.files'), files), button(t('common.save'), async () => {
      await request('/api/task/tests/configure', { ...scope, revision, configuration: { name: configuration.value, framework: framework.value, ...(configFile.value.trim() ? { config: configFile.value.trim() } : {}), files: files.value.split(',').map(file => file.trim()).filter(Boolean) } }); await render();
    }), button(t('tests.cancel'), () => request('/api/task/tests/cancel', scope)), status, list);
  });
}

export function verificationHistoryButton(project: string, task: string): HTMLElement {
  return button(t('tests.history'), async () => {
    const rows = await request<VerificationHistoryEntry[]>(query('/api/task/verify/history', { project, task }));
    const list = el('div');
    for (const entry of [...rows].reverse()) list.append(el('h3', '', `${entry.at} · ${t(entry.result.ok ? 'tests.passed' : 'tests.failed')}`), el('p', 'muted', `${entry.before} → ${entry.after ?? '—'}`), el('pre', '', entry.result.output));
    modal(t('tests.history'), el('p', 'muted', t('tests.historyHint')), list);
  });
}
