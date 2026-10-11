import type { MemoryFile } from '../../shared/types.ts';
import { ApiFailure, query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, disclosure, el, field, input, row, run, toast } from './dom.ts';
import { markdown } from './markdown.ts';

export function memoryPanel(project: string): HTMLDetailsElement {
  const list = el('div'); const name = input(); name.maxLength = 120; name.placeholder = 'INDEX.md';
  const text = area(); text.rows = 14; text.maxLength = 262144;
  const preview = el('div'); let revision: string | null = null; let selected = ''; let loaded = false;
  const status = el('p', 'muted', t('memory.hint'));
  const save = button(t('common.save'), async () => {
    try {
      const file = await request<MemoryFile>('/api/project/memory', { project, name: name.value, text: text.value, revision });
      selected = file.name; revision = file.revision; name.disabled = true;
      await refresh(); preview.replaceChildren(markdown(file.text)); toast(t('common.saved'));
    } catch (error) {
      if (error instanceof ApiFailure && error.body.error === 'conflict') status.textContent = t(error.body.detail === 'editor_running' ? 'detail.editor_running' : 'memory.conflict');
      throw error;
    }
  });
  const remove = button(t('common.remove'), async () => {
    if (!selected || !revision || !await confirmModal(t('common.remove'), t('memory.deleteConfirm', { name: selected }), t('common.remove'))) return;
    try {
      await request('/api/project/memory/delete', { project, name: selected, revision, confirm: true });
      clear(); await refresh();
    } catch (error) {
      if (error instanceof ApiFailure && error.body.error === 'conflict') status.textContent = t(error.body.detail === 'editor_running' ? 'detail.editor_running' : 'memory.conflict');
      throw error;
    }
  }, 'danger');
  function clear(): void {
    selected = ''; revision = null; name.value = ''; name.disabled = false; text.value = ''; preview.replaceChildren(); remove.disabled = true;
    status.textContent = t('memory.hint');
  }
  async function open(fileName: string): Promise<void> {
    const file = await request<MemoryFile>(query('/api/project/memory', { project, name: fileName }));
    selected = file.name; revision = file.revision; name.value = file.name; name.disabled = true; text.value = file.text;
    remove.disabled = false; status.textContent = t('memory.hint'); preview.replaceChildren(markdown(file.text));
  }
  async function refresh(): Promise<void> {
    const { files } = await request<{ files: string[] }>(query('/api/project/memory', { project }));
    list.replaceChildren(...files.map(file => button(file, () => open(file)))); loaded = true;
    remove.disabled = !selected;
  }
  text.oninput = () => preview.replaceChildren(markdown(text.value));
  clear();
  const panel = disclosure(t('memory.title'), status, row(button(t('memory.refresh'), async () => { await refresh(); if (selected) await open(selected); }), button(t('memory.create'), clear)), list, field(t('common.name'), name), text, row(save, remove), disclosure(t('memory.preview'), preview));
  panel.addEventListener('toggle', () => { if (panel.open && !loaded) void run(refresh); });
  return panel;
}
