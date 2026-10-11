import type { CareBackup, CareHealth } from '../../shared/types.ts';
import { api, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, card, confirmModal, el, field, input, modal, readLocal, row, storeLocal, type ViewContext } from './dom.ts';

export function carePanel(context: ViewContext): HTMLElement {
  const status = el('div'); status.setAttribute('aria-live', 'polite');
  const network = input(); network.type = 'checkbox';
  const external = input(); external.type = 'checkbox'; external.checked = true;
  const backups = el('div'); const destination = input('', t('care.destination'));
  const yes = (value: boolean) => t(value ? 'care.yes' : 'care.no');
  const show = (health: CareHealth) => {
    status.replaceChildren(...[
      `Node ${health.node} · Electron ${health.electron ?? t('care.no')} · Git ${health.git.version || yes(health.git.available)}`,
      `${t('care.writable')}: ${yes(health.writable)} · ${t('care.loopback')}: ${yes(health.loopback)} · ${t('care.binding')}: ${yes(health.boundToLoopback)}`,
      `${t('care.network')}: ${health.network === 'not-tested' ? t('care.unknown') : yes(health.network === 'reachable')}`,
      `${t('care.trust')}: ${health.buildTrust === 'signed' ? t('care.yes') : t('care.unknown')}`,
      ...health.clis.map(cli => `${cli.name}: ${yes(cli.available)} ${cli.version} · ${t('care.login')}: ${cli.loginState === 'unknown' ? t('care.unknown') : yes(cli.loginState === 'stored')} · ${t('care.fullAccess')}: ${cli.fullAccess ? t('care.yes') : t('care.no')}`),
    ].map(text => el('p', '', text)));
  };
  const checked = button(t('care.check'), async () => {
    show(await request<CareHealth>('/api/care/health', { network: network.checked }));
    panel.dataset['checked'] = 'true';
  });
  const refresh = async () => {
    const entries = (await request<{ backups: CareBackup[] }>('/api/care/backups')).backups;
    backups.replaceChildren(...entries.map(backup => row(
      el('span', '', `${backup.createdAt} · ${t(backup.complete ? 'care.complete' : 'care.partial')} · ${backup.externalCount}`),
      button(t('care.restore'), async () => {
        if (!await confirmModal(t('care.restore'), t('care.restoreConfirm'))) return;
        const restored = await request<{ root: string }>('/api/care/restore', { id: backup.id, destination: destination.value.trim() });
        const open = button(t('care.open'), async () => { await api.workspace(restored.root); await context.refresh(); location.hash = '#/'; });
        modal(t('care.restore'), el('p', '', restored.root), open);
      }),
    )));
  };
  const download = el('a', 'button', t('care.diagnostics')); download.href = '/api/care/diagnostics'; download.download = 'yumeewade-diagnostics.json';
  const panel = card(t('care.title'), el('p', '', t('care.risk')), field(t('care.network'), network), checked, status,
    el('p', '', t('care.scope')), el('p', 'warning', t('care.secret')), field(t('care.external'), external),
    button(t('care.backup'), async () => { if (!await confirmModal(t('care.backup'), t('care.secret'))) return; await request('/api/care/backup', { includeExternal: external.checked }); await refresh(); }),
    button(t('care.list'), refresh), field(t('care.destination'), destination), backups,
    el('p', '', t('care.diagnosticScope')), download);
  return panel;
}
export function careButton(context: ViewContext): HTMLElement { return button(t('care.title'), () => modal(t('care.title'), carePanel(context))); }
export function showInitialCare(context: ViewContext): void {
  if (readLocal<boolean>('yumeewade.care.checked', false)) return;
  const panel = carePanel(context);
  modal(t('care.title'), el('p', '', t('care.initial')), panel, button(t('care.acknowledge'), () => {
    if (panel.dataset['checked'] !== 'true') return;
    storeLocal('yumeewade.care.checked', true);
    panel.closest('dialog')?.close();
  }));
}
