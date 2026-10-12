import type { LogTail } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, card, el, field, input, row, run, select, toast } from './dom.ts';
import { copyText } from './markdown.ts';

export function logViewer(): HTMLElement {
  const level = select((['all', 'info', 'warn', 'error'] as const).map(value => ({ value, label: t(`coreLog.${value}`) })), 'all');
  const filter = input(); filter.type = 'search'; filter.maxLength = 200;
  const output = area(); output.readOnly = true; output.rows = 16; output.spellcheck = false; output.setAttribute('aria-label', t('coreLog.title'));
  const status = el('p', 'muted'); status.setAttribute('aria-live', 'polite');
  let tail: LogTail = { text: '', truncated: false };
  const render = () => {
    const term = filter.value.toLocaleLowerCase();
    output.value = tail.text.split('\n').filter(line => {
      if (!line.toLocaleLowerCase().includes(term)) return false;
      if (level.value === 'all') return true;
      try {
        const entry: unknown = JSON.parse(line);
        return !!entry && typeof entry === 'object' && 'level' in entry && entry.level === level.value;
      } catch { return false; }
    }).join('\n');
    status.textContent = t(tail.truncated ? 'coreLog.truncated' : 'coreLog.complete');
  };
  const refresh = async () => { tail = await request<LogTail>('/api/care/log'); render(); };
  level.onchange = render; filter.oninput = render;
  const node = card(t('coreLog.title'), el('p', 'warning', t('coreLog.warning')), field(t('coreLog.level'), level), field(t('coreLog.filter'), filter),
    row(button(t('common.refresh'), refresh), button(t('coreLog.copy'), async () => { await copyText(output.value); toast(t('coreLog.copied')); })), status, output);
  void run(refresh); return node;
}
