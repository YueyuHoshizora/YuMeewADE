import { query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, row } from './dom.ts';
import { markdown } from './markdown.ts';

export const isImage = (path: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
export class FilePreview {
  readonly node = el('div');
  private readonly tools = el('div');
  private readonly body = el('div');
  private path = '';
  private text = '';
  private mode: 'edit' | 'preview' | 'split' = 'edit';
  private timer: number | undefined;
  private readonly code: HTMLElement;
  private readonly ids: Record<string, string>;
  constructor(code: HTMLElement, ids: Record<string, string>) {
    this.code = code; this.ids = ids;
    this.node.append(this.tools, this.body);
    this.body.style.overflow = 'auto'; this.body.style.maxHeight = '65vh';
  }
  open(path: string, text: string, size: number): void {
    window.clearTimeout(this.timer); this.path = path; this.text = text;
    this.code.parentElement!.style.display = 'block';
    this.tools.replaceChildren(); this.body.replaceChildren(); this.code.hidden = false;
    if (isImage(path)) {
      this.code.hidden = true;
      const image = el('img'); image.alt = path;
      const info = el('p', 'muted', t('preview.size', { size }));
      const fit = () => { image.style.maxWidth = '100%'; image.style.maxHeight = '55vh'; };
      fit();
      image.onload = () => { info.textContent = t('preview.dimensions', { width: image.naturalWidth, height: image.naturalHeight, size }); };
      image.onerror = () => { info.textContent = t('preview.imageError'); };
      image.src = query('/api/editor/image', { ...this.ids, path });
      this.tools.append(row(button(t('preview.fit'), fit), button(t('preview.actual'), () => { image.style.maxWidth = 'none'; image.style.maxHeight = 'none'; }), info));
      this.body.append(image); return;
    }
    if (/\.(md|markdown)$/i.test(path)) {
      this.tools.append(row(...(['edit', 'preview', 'split'] as const).map(mode => button(t(`preview.${mode}`), () => { this.mode = mode; this.render(); }))));
      this.render();
    }
  }
  update(text: string): void {
    this.text = text; window.clearTimeout(this.timer);
    if (/\.(md|markdown)$/i.test(this.path)) this.timer = window.setTimeout(() => this.render(), 180);
  }
  private render(): void {
    this.code.hidden = this.mode === 'preview';
    this.body.replaceChildren(...(this.mode === 'edit' ? [] : [markdown(this.text)]));
    this.code.parentElement!.style.display = this.mode === 'split' ? 'flex' : 'block';
    this.code.style.flex = '1'; this.code.style.minWidth = '0';
    this.node.style.flex = '1'; this.node.style.minWidth = '0';
  }
  clear(): void { window.clearTimeout(this.timer); this.path = ''; this.code.hidden = false; this.code.parentElement!.style.display = 'block'; this.tools.replaceChildren(); this.body.replaceChildren(); }
  destroy(): void { window.clearTimeout(this.timer); }
}
