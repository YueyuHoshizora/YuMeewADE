import type { UpdateAsset, UpdateInfo } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { button, el, readLocal, row, storeLocal } from './dom.ts';
import { markdown } from './markdown.ts';

const SKIP_KEY = 'yumeewade.skipUpdate';

/** 使用者按「略過此版本」後，只有更新的版本才會再提示。 */
export function visibleUpdate(info: UpdateInfo | undefined): UpdateInfo | undefined {
  return info && readLocal<string>(SKIP_KEY, '') !== info.version ? info : undefined;
}

function size(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(0)} MB`; }
const open = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); };

function download(asset: UpdateAsset): HTMLButtonElement {
  const label = t(asset.kind === 'installer' ? 'update.installer' : 'update.portable');
  const node = button(`${label}（${size(asset.size)}）`, () => open(asset.url), asset.kind === 'installer' ? 'primary' : '');
  node.title = asset.name; return node;
}

/** 標題列旁的小標籤；點開看說明與下載。 */
export function updateChip(info: UpdateInfo, current: string, redraw: () => void): HTMLButtonElement {
  const chip = button(`↑ ${t('update.available', { version: info.version })}`, () => openUpdateDialog(info, current, redraw), 'update-chip');
  chip.title = t('update.title'); return chip;
}

export function openUpdateDialog(info: UpdateInfo, current: string, redraw: () => void): void {
  const dialog = el('dialog', 'modal update-modal');
  const notes = info.notes.trim() ? [el('h3', '', t('update.notes')), (() => { const body = markdown(info.notes); body.classList.add('update-notes'); return body; })()] : [];
  const downloads = info.assets.length ? info.assets.map(download) : [el('p', 'muted', t('update.noAsset'))];
  dialog.append(
    el('h2', '', t('update.title')),
    el('p', '', t('update.summary', { version: info.version, current })),
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
