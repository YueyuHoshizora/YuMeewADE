import { labelValue, t } from '../i18n/index.ts';
import { turnItems } from '../components/tree.ts';
import { button, el, link, row, taskHash, type View, type ViewContext } from '../components/dom.ts';
import { onboardingBanner } from '../components/onboarding.ts';
import { openDeliveryReview, type DeliveryReview } from '../components/delivery.ts';
import { openProjectFromFolder } from './projects.ts';

export function turnView(context: ViewContext): View {
  const node = el('div', 'page'); const tabs = el('div', 'tabs'); const list = el('div', 'turn-list'); const hint = el('p', 'muted'); let selected: 'reply' | 'confirm' = 'reply';
  // Until the user picks a tab, show whichever one has work instead of an empty "reply" list.
  let picked = false;
  let review: DeliveryReview | undefined;
  // A workspace without projects has nothing to triage; point at the two ways to get one instead of an empty list.
  const welcome = el('section', 'card welcome');
  welcome.append(el('h2', '', t('turn.welcomeTitle')), el('p', 'muted', t('turn.welcomeBody')), row(button(t('project.new'), () => { location.hash = '#/new'; }, 'primary'), button(t('project.openExisting'), () => openProjectFromFolder(context))));
  const heading = el('h1', '', t('nav.turn'));
  // Nothing waiting: say so plainly and offer the work in progress, instead of two zero tabs over an empty list.
  const clear = el('section', 'turn-clear');
  node.append(onboardingBanner(context));
  function recentWork(): HTMLElement[] {
    const running = new Set(context.state.running.map(r => `${r.project}/${r.task}`));
    const items = context.state.projects.flatMap(project => project.tasks.filter(task => task.state !== '完成').map(task => ({ project, task, running: running.has(`${project.id}/${task.id}`) })));
    items.sort((a, b) => Number(b.running) - Number(a.running) || b.task.updated.localeCompare(a.task.updated));
    return items.slice(0, 6).map(({ project, task, running }) => {
      const item = el('li', 'turn-recent-item');
      item.append(link(task.title, taskHash(project.id, task.id), 'turn-title'), el('span', 'muted', project.name), el('span', `state-chip${running ? ' running' : ''}`, running ? t('overview.running') : t(`state.${task.state}`)));
      return item;
    });
  }
  function render(): void {
    const empty = !context.state.projects.length;
    const { reply, confirm } = turnItems(context.state);
    const settled = !empty && !reply.length && !confirm.length;
    welcome.hidden = !empty; heading.hidden = empty; for (const part of [tabs, hint, list]) part.hidden = empty || settled;
    clear.hidden = !settled;
    if (settled) {
      const recent = recentWork(); const items = el('ul', 'turn-recent');
      items.append(...recent);
      clear.replaceChildren(el('h2', '', t('turn.clearTitle')), el('p', 'muted', t('turn.clearBody')), ...(recent.length ? [el('h3', '', t('turn.recent')), items] : []));
      return;
    }
    if (!picked) selected = !reply.length && confirm.length ? 'confirm' : 'reply';
    tabs.replaceChildren(button(t('turn.reply', { n: reply.length }), () => { selected = 'reply'; picked = true; render(); }, selected === 'reply' ? 'active' : ''), button(t('turn.confirm', { n: confirm.length }), () => { selected = 'confirm'; picked = true; render(); }, selected === 'confirm' ? 'active' : ''));
    hint.textContent = t(selected === 'reply' ? 'turn.replyHint' : 'turn.confirmHint');
    list.replaceChildren(...(selected === 'reply' ? reply : confirm).map(({ project, task, waiting }) => {
      const item = el('div', 'turn-item'); item.append(el('p', 'muted', project.name), link(task.title, taskHash(project.id, task.id), 'turn-title'));
      // A reply happens on the task page, where the question card and approvals are; give it the same weight as review.
      if (selected === 'reply') item.append(el('p', '', waiting ? t('permission.waiting') : task.question), row(button(t('focus.attend'), () => { location.hash = taskHash(project.id, task.id); }, 'primary')));
      else {
        // Progress and the AI's own "next" line help decide between approving and asking to continue.
        const progress = [task.steps.length ? t('task.steps', { done: task.steps.filter(step => step.done).length, total: task.steps.length }) : '', task.next ? labelValue(t('tasks.next'), task.next) : ''].filter(Boolean);
        if (progress.length) item.append(el('p', 'muted', progress.join(' · ')));
        item.append(row(button(t('delivery.review'), () => {
          review?.dispose();
          review = openDeliveryReview(context, project, task);
        }, 'primary')));
      }
      return item;
    })); if (!list.childNodes.length) list.append(el('p', 'empty', t('common.empty')));
  }
  node.append(welcome, heading, clear, tabs, hint, list); render();
  return { node, update: state => { context.state = state; review?.update(); render(); }, dispose: () => review?.dispose() };
}
