import type { UpdateAsset, UpdateInfo, UpdateDownloadResult } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, errorMessage, readLocal, row, storeLocal } from './dom.ts';
import { markdown } from './markdown.ts';

const SKIP_KEY = 'yumeewade.skipUpdate';

/** 使用者按「略過此版本」後，只有更新的版本才會再提示。 */
export function visibleUpdate(info: UpdateInfo | undefined): UpdateInfo | undefined {
  return info && readLocal<string>(SKIP_KEY, '') !== info.version ? info : undefined;
}

function size(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(0)} MB`; }
const open = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); };

function download(asset: UpdateAsset, info: UpdateInfo): HTMLElement {
  const status = el('p', 'muted', '');
  const actions = row();
  const node = button(`${t(asset.kind === 'installer' ? 'update.installer' : 'update.portable')} (${size(asset.size)})`, async () => {
    if (!window.confirm(t('updateTrust.confirmDownload'))) return;
    node.disabled = true; status.textContent = t('updateTrust.downloading');
    try {
      const result = await request<UpdateDownloadResult>('/api/update/download', { version: info.version, name: asset.name, confirmed: true });
      status.textContent = t(result.publisherTrusted ? 'updateTrust.trusted' : 'updateTrust.integrityOnly');
      const action = async (launch: boolean): Promise<void> => {
        if (launch && !window.confirm(t('updateTrust.confirmLaunch'))) return;
        try { await request('/api/update/action', { token: result.token, launch, confirmed: true }); }
        catch (error) { status.textContent = `${t('updateTrust.failed')} ${errorMessage(error)}`; }
      };
      actions.replaceChildren(button(t('updateTrust.reveal'), () => { void action(false); }));
      if (result.canLaunch) actions.append(button(t('updateTrust.launch'), () => { void action(true); }, 'primary'));
    } catch (error) { status.textContent = `${t('updateTrust.failed')} ${errorMessage(error)}`; }
    finally { node.disabled = false; }
  }, asset.kind === 'installer' ? 'primary' : '');
  node.title = asset.name;
  const container = el('div'); container.append(node, status, actions); return container;
}

/** 標題列旁的小標籤；點開看說明與下載。 */
export function updateChip(info: UpdateInfo, current: string, redraw: () => void): HTMLButtonElement {
  const chip = button(`↑ ${t('update.available', { version: info.version })}`, () => openUpdateDialog(info, current, redraw), 'update-chip');
  chip.title = t('update.title'); return chip;
}

export function openUpdateDialog(info: UpdateInfo, current: string, redraw: () => void): void {
  const dialog = el('dialog', 'modal update-modal');
  const notes = info.notes.trim() ? [el('h3', '', t('update.notes')), (() => { const body = markdown(info.notes); body.classList.add('update-notes'); return body; })()] : [];
  const downloads = info.assets.length ? info.assets.map(asset => download(asset, info)) : [el('p', 'muted', t('update.noAsset'))];
  dialog.append(
    el('h2', '', t('update.title')),
    el('p', '', t('updateTrust.summary', { version: info.version, current })),
    el('p', 'muted', t('updateTrust.warning')),
    ...notes,
    row(...downloads, button(t('update.releasePage'), () => open(info.url))),
    row(
      button(t('update.skip'), () => { storeLocal(SKIP_KEY, info.version); dialog.close(); redraw(); }),
      button(t('common.close'), () => dialog.close()),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}
