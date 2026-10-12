import type { CareBackup, CareHealth, CareCapacity, CareLifecycle } from '../../shared/types.ts';
import { ApiFailure, api, coreFetch, request } from '../api.ts';
import { labelValue, t } from '../i18n/index.ts';
import { button, card, confirmModal, el, errorMessage, field, input, modal, readLocal, row, storeLocal, toast, type ViewContext } from './dom.ts';
import { formatBytes, localDateTime } from './display.ts';
import { logViewer } from './log-viewer.ts';

export function carePanel(context: ViewContext): HTMLElement {
  const status = el('div'); status.setAttribute('aria-live', 'polite');
  const network = input(); network.type = 'checkbox';
  const external = input(); external.type = 'checkbox'; external.checked = true;
  const backups = el('div'); const destination = input('', t('care.destination'));
  const capacity = el('p'); const scheduleStatus = el('p'); scheduleStatus.setAttribute('aria-live', 'polite');
  const password = input(); password.type = 'password'; password.autocomplete = 'new-password';
  const file = input(); file.type = 'file'; file.accept = '.ymae,application/octet-stream';
  const enabled = input(); enabled.type = 'checkbox';
  const interval = input('24'); interval.type = 'number'; interval.min = '1'; interval.max = '8760';
  const retention = input('10'); retention.type = 'number'; retention.min = '1'; retention.max = '1000';
  /** Undefined when the password breaks the rule; callers explain that instead of reporting a network failure. */
  const passwordHeaders = (): Record<string, string> | undefined => {
    const bytes = new TextEncoder().encode(password.value);
    if (password.value.length < 12 || bytes.length > 1024) { toast(t('care.passwordRule')); return undefined; }
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return { 'X-Backup-Password': btoa(text) };
  };
  const binary = async (url: string, body: BodyInit, headers: Record<string, string>): Promise<Response> => {
    try {
      const response = await coreFetch(url, { method: 'POST', headers, body });
      // Keep the server's status/detail so showError names the real cause (wrong password, corrupt file, …).
      if (!response.ok) throw new ApiFailure(response.status, await response.json().catch(() => ({ error: 'internal', message: '' })));
      return response;
    } finally { password.value = ''; }
  };
  const showSchedule = (value: CareLifecycle) => {
    enabled.checked = value.schedule.enabled; interval.value = String(value.schedule.intervalHours); retention.value = String(value.schedule.retention);
    scheduleStatus.textContent = `${labelValue(t('care.lastSuccess'), value.lastSuccess ? localDateTime(value.lastSuccess) : t('care.unknown'))} · ${labelValue(t('care.nextAttempt'), value.nextAttempt ? localDateTime(value.nextAttempt) : t('care.no'))}${value.lastFailure ? ` · ${t('care.scheduleFailed')}` : ''}`;
    scheduleStatus.className = value.lastFailure ? 'warning' : '';
  };
  const yes = (value: boolean) => t(value ? 'care.yes' : 'care.no');
  const show = (health: CareHealth) => {
    status.replaceChildren(...[
      `Node ${health.node} · Electron ${health.electron ?? t('care.no')} · Git ${health.git.version || yes(health.git.available)}`,
      `${labelValue(t('care.writable'), yes(health.writable))} · ${labelValue(t('care.loopback'), yes(health.loopback))} · ${labelValue(t('care.binding'), yes(health.boundToLoopback))}`,
      labelValue(t('care.network'), health.network === 'not-tested' ? t('care.unknown') : yes(health.network === 'reachable')),
      labelValue(t('care.trust'), health.buildTrust === 'signed' ? t('care.yes') : t('care.unknown')),
      ...health.clis.map(cli => `${cli.name}: ${yes(cli.available)} ${cli.version} · ${labelValue(t('care.login'), cli.loginState === 'unknown' ? t('care.unknown') : yes(cli.loginState === 'stored'))} · ${labelValue(t('care.fullAccess'), cli.fullAccess ? t('care.yes') : t('care.no'))}`),
    ].map(text => el('p', '', text)));
  };
  const checked = button(t('care.check'), async () => {
    show(await request<CareHealth>('/api/care/health', { network: network.checked }));
    panel.dataset['checked'] = 'true'; panel.dispatchEvent(new Event('checked'));
  });
  const refresh = async () => {
    const entries = (await request<{ backups: CareBackup[] }>('/api/care/backups')).backups;
    const disk = await request<CareCapacity>('/api/care/capacity');
    capacity.textContent = `${labelValue(t('care.capacity'), formatBytes(disk.usedBytes))} / ${formatBytes(disk.availableBytes)} ${t('care.available')}`;
    showSchedule(await request<CareLifecycle>('/api/care/schedule'));
    backups.replaceChildren(...entries.map(backup => row(
      el('span', '', `${localDateTime(backup.createdAt)} · ${t(backup.complete ? 'care.complete' : 'care.partial')} · ${t('care.externalCount', { n: backup.externalCount })} · ${formatBytes(backup.bytes)}`),
      button(t('care.restore'), async () => {
        if (!await confirmModal(t('care.restore'), t('care.restoreConfirm'), t('care.restore'))) return;
        const restored = await request<{ root: string }>('/api/care/restore', { id: backup.id, destination: destination.value.trim() });
        const open = button(t('care.open'), async () => { await api.workspace(restored.root); await context.refresh(); location.hash = '#/'; });
        modal(t('care.restore'), el('p', '', restored.root), open);
      }),
      button(t('care.delete'), async () => {
        if (!await confirmModal(t('care.delete'), `${t('care.deleteConfirm')} ${backup.id}`, t('care.delete'))) return;
        await request('/api/care/delete', { id: backup.id, confirmation: backup.id }); await refresh();
      }),
      button(t('care.export'), async () => {
        const secret = passwordHeaders(); if (!secret) return;
        if (!await confirmModal(t('care.export'), t('care.secret'), t('care.export'))) return;
        const response = await binary('/api/care/export', JSON.stringify({ id: backup.id }), { ...secret, 'Content-Type': 'application/json' });
        const url = URL.createObjectURL(await response.blob()); const link = el('a'); link.href = url; link.download = `${backup.id}.ymae`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      }),
    )));
  };
  const download = el('a', 'button', t('care.diagnostics')); download.href = '/api/care/diagnostics'; download.download = 'yumeewade-diagnostics.json';
  const panel = card(t('care.title'), el('p', '', t('care.risk')), field(t('care.network'), network), checked, status,
    el('p', '', t('care.scope')), el('p', 'warning', t('care.secret')), field(t('care.external'), external),
    row(button(t('care.backup'), async () => { if (!await confirmModal(t('care.backup'), t('care.secret'), t('care.backup'))) return; await request('/api/care/backup', { includeExternal: external.checked }); await refresh(); }),
      button(t('care.list'), refresh)), capacity, field(t('care.destination'), destination), backups,
    field(t('care.password'), password), el('p', '', t('care.passwordRule')),
    field(t('care.portableFile'), file), button(t('care.import'), async () => {
      const selected = file.files?.[0]; if (!selected) return;
      const secret = passwordHeaders(); if (!secret) return;
      if (!await confirmModal(t('care.import'), t('care.restoreConfirm'), t('care.import'))) return;
      const response = await binary(`/api/care/import?destination=${encodeURIComponent(destination.value.trim())}`, selected, { ...secret, 'Content-Type': 'application/octet-stream' });
      const restored = await response.json() as { root: string };
      modal(t('care.import'), el('p', '', restored.root), button(t('care.open'), async () => { await api.workspace(restored.root); await context.refresh(); location.hash = '#/'; }));
      file.value = ''; await refresh();
    }),
    field(t('care.schedule'), enabled), field(t('care.interval'), interval), field(t('care.retention'), retention),
    button(t('care.saveSchedule'), async () => {
      if (enabled.checked && !await confirmModal(t('care.schedule'), t('care.secret'), t('care.saveSchedule'))) return;
      showSchedule(await request<CareLifecycle>('/api/care/schedule', { enabled: enabled.checked, intervalHours: Number(interval.value), retention: Number(retention.value), includeExternal: external.checked }));
    }), scheduleStatus,
    el('p', '', t('care.diagnosticScope')), download);
  panel.append(logViewer());
  void refresh().catch(error => { status.textContent = errorMessage(error); });
  return panel;
}
export function careButton(context: ViewContext): HTMLElement { return button(t('care.title'), () => modal(t('care.title'), carePanel(context))); }
export function showInitialCare(context: ViewContext): void {
  if (readLocal<boolean>('yumeewade.care.checked', false)) return;
  const panel = carePanel(context);
  // Disabled until the check ran, so acknowledging never silently does nothing.
  const acknowledge = button(t('care.acknowledge'), () => {
    if (panel.dataset['checked'] !== 'true') return;
    storeLocal('yumeewade.care.checked', true);
    panel.closest('dialog')?.close();
  }, 'primary');
  acknowledge.disabled = true;
  panel.addEventListener('checked', () => { acknowledge.disabled = false; acknowledge.focus(); });
  modal(t('care.title'), el('p', '', t('care.initial')), panel, acknowledge);
}
