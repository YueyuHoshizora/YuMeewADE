import type { Limits, UploadResult } from '../../shared/types.ts';
import { api, request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, iconButton, showError, toast } from './dom.ts';

export function attachments(project: string, limits: Limits, target: HTMLElement, scope = 'quickstart'): { node: HTMLElement; strip: HTMLElement; ids: () => string[]; clear: () => Promise<void>; ready: () => Promise<void>; dispose: () => void } {
  const node = el('div', 'attachments'); const strip = el('div', 'image-strip'); const picker = el('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp,image/gif'; picker.multiple = true; picker.hidden = true;
  let images: UploadResult[] = []; let pending = 0; let disposed = false;
  let chain = request<{ images: UploadResult[] }>(query('/api/chat/draft', { project, scope })).then(draft => { images = draft.images; if (!disposed) render(); });
  const status = el('span', 'muted');
  function render(): void {
    strip.replaceChildren(...images.map(image => {
      const tile = el('div', 'image-tile'); const img = el('img'); img.src = image.url; img.alt = image.name;
      tile.append(img, iconButton('×', `${t('common.remove')}: ${image.name}`, async () => {
        await request('/api/chat/draft', { project, scope, remove: [image.id] });
        images = images.filter(i => i.id !== image.id); render();
      }, 'image-remove'));
      return tile;
    }));
    status.textContent = pending ? t('chat.uploading') : '';
  }
  function add(files: File[]): void {
    for (const file of files) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name) || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast(t('chat.imageType')); continue; }
      if (file.size > limits.uploadBytes) { toast(t('chat.imageTooLarge')); continue; }
      if (images.length + pending >= limits.imagesPerSend) { toast(t('chat.imageLimit', { n: limits.imagesPerSend })); break; }
      pending++; render();
      chain = chain.then(async () => {
        try { const result = await api.upload(project, file, scope); images.push(result); }
        catch (error) { showError(error); }
        finally { pending--; if (!disposed) render(); }
      });
    }
  }
  picker.onchange = () => { add(Array.from(picker.files ?? [])); picker.value = ''; };
  const drop = (event: DragEvent) => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); add(Array.from(event.dataTransfer.files)); };
  const drag = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
  const paste = (event: ClipboardEvent) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); add(files); } };
  target.addEventListener('drop', drop); target.addEventListener('dragover', drag); target.addEventListener('paste', paste);
  node.append(strip, button(t('chat.attach'), () => picker.click(), 'subtle'), picker, status);
  return { node, strip, ids: () => images.map(i => i.id), clear: async () => {
    await chain;
    const ids = images.map(image => image.id);
    await request('/api/chat/draft', { project, scope, remove: ids });
    images = images.filter(image => !ids.includes(image.id)); if (!disposed) render();
  }, ready: () => chain, dispose: () => { disposed = true; target.removeEventListener('drop', drop); target.removeEventListener('dragover', drag); target.removeEventListener('paste', paste); } };
}
