import type { Busy } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, run } from './dom.ts';
import { localTime } from './display.ts';

export function renderPermissions(host: HTMLElement, busy: Busy | null, project: string, task: string): void {
  host.replaceChildren();
  if (busy?.approvalUnsupported) host.append(el('p', 'muted', t('permission.unsupported')));
  for (const card of busy?.approvals ?? []) {
    const item = el('article', 'chat-card permission-card');
    item.setAttribute('role', 'group');
    item.setAttribute('aria-label', t('permission.waiting'));
    const remember = el('input');
    remember.type = 'checkbox';
    const label = el('label');
    label.append(remember, document.createTextNode(t('permission.turn')));
    const answer = (allow: boolean) => run(async () => {
      for (const b of item.querySelectorAll('button')) b.disabled = true;
      try { await request('/api/chat/approve', { project, task, id: card.id, allow, turn: allow && remember.checked }); }
      catch (err) { for (const b of item.querySelectorAll('button')) b.disabled = false; throw err; }
    });
    item.append(el('strong', '', `${t('permission.waiting')} · ${card.tool}`), el('pre', '', card.summary), el('p', 'muted', `${t('permission.expires')} ${localTime(card.expiresAt)}`), label,
      button(t('permission.allow'), () => answer(true), 'primary'), button(t('permission.deny'), () => answer(false), 'danger'));
    host.append(item);
  }
}
