import type { ArchiveEntry } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, confirmModal, el, modal, projectHash, row, taskHash, type ViewContext } from './dom.ts';

export function archiveButton(context: ViewContext, project?: string): HTMLElement {
  return button(t('archive.browse'), async () => {
    const content = el('div', 'stack');
    const render = async (): Promise<void> => {
      const entries = await request<ArchiveEntry[]>(`/api/archive/list${project ? `?project=${encodeURIComponent(project)}` : ''}`);
      content.replaceChildren();
      if (!entries.length) content.append(el('p', '', t('archive.empty')));
      for (const entry of entries) content.append(row(
        el('span', '', `${entry.name} · ${new Date(entry.archivedAt).toLocaleString()}`),
        button(t('archive.restore'), async () => {
          if (!(await confirmModal(t('archive.restore'), t('archive.confirmRestore', { name: entry.name }), t('archive.restore')))) return;
          const restored = await request<ArchiveEntry>('/api/archive/restore', { key: entry.key, ...(project ? { project } : {}) });
          await context.refresh();
          await render();
          window.location.hash = restored.task ? taskHash(restored.project, restored.task) : projectHash(restored.project);
        }),
      ));
    };
    await render();
    modal(t('archive.browse'), content);
  });
}
