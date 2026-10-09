import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { needsReply } from '../components/tree.ts';
import { button, el, link, row, taskHash, type View, type ViewContext } from '../components/dom.ts';

export function turnView(context: ViewContext): View {
  const node = el('div', 'page'); const tabs = el('div', 'tabs'); const list = el('div', 'turn-list'); const hint = el('p', 'muted'); let selected: 'reply' | 'confirm' = 'reply';
  function render(): void {
    const items = context.state.projects.flatMap(project => project.tasks.map(task => ({ project, task })));
    const reply = items.filter(({ task }) => needsReply(task)); const confirm = items.filter(({ task }) => task.confirm && !needsReply(task));
    tabs.replaceChildren(button(t('turn.reply', { n: reply.length }), () => { selected = 'reply'; render(); }, selected === 'reply' ? 'active' : ''), button(t('turn.confirm', { n: confirm.length }), () => { selected = 'confirm'; render(); }, selected === 'confirm' ? 'active' : ''));
    hint.textContent = t(selected === 'reply' ? 'turn.replyHint' : 'turn.confirmHint');
    list.replaceChildren(...(selected === 'reply' ? reply : confirm).map(({ project, task }) => {
      const item = el('div', 'turn-item'); item.append(el('p', 'muted', project.name), link(task.title, taskHash(project.id, task.id), 'turn-title'));
      if (selected === 'reply') item.append(el('p', '', task.question));
      else item.append(row(button(t('turn.approve'), async () => { await request('/api/task/completion', { project: project.id, task: task.id, action: 'approve' }); await context.refresh(); }, 'primary'), button(t('turn.continue'), async () => { await request('/api/task/completion', { project: project.id, task: task.id, action: 'continue' }); await context.refresh(); })));
      return item;
    })); if (!list.childNodes.length) list.append(el('p', 'empty', t('common.empty')));
  }
  node.append(el('h1', '', t('nav.turn')), tabs, hint, list); render(); return { node, update: state => { context.state = state; render(); } };
}
