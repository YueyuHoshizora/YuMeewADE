import path from 'node:path';
import type { ChatRow, Step, TaskSections } from '../shared/types.ts';

const RECORD_HEADINGS: [keyof TaskSections, string][] = [['done', '做了什麼'], ['next', '下一步'], ['cautions', '注意'], ['memo', '備註']];

/**
 * `ledger` is the task file's steps and free-text sections; whatever has content precedes the conversation.
 * The export is meant to be handed to someone else: the workspace root and then the home folder (account name) are masked.
 */
export function formatTranscript(title: string, rows: ChatRow[], workspaceRoot: string, tools = false, ledger?: { steps: Step[]; sections: TaskSections }, home = ''): string {
  // Only a whole path segment counts: `/Users/al` must not eat the start of `/Users/alice`.
  const homePattern = home.length > 1 ? new RegExp(`${home.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'gu') : undefined;
  const safe = (text: string) => {
    const masked = text.replaceAll(workspaceRoot, '[工作區]');
    return homePattern ? masked.replace(homePattern, '~') : masked;
  };
  const block = (text: string) => closeFence(safe(text));
  const sections = [`# ${safe(title).replace(/[\r\n]/gu, ' ')}`];
  const record = [
    ...(ledger?.steps.length ? [`### 步驟\n\n${safe(ledger.steps.map(step => `- [${step.done ? 'x' : ' '}] ${step.text}`).join('\n'))}`] : []),
    ...RECORD_HEADINGS.filter(([key]) => ledger?.sections[key].length).map(([key, heading]) => `### ${heading}\n\n${block(ledger!.sections[key].join('\n'))}`),
  ];
  if (record.length) sections.push(['## 作業紀錄', ...record].join('\n\n'));
  for (const row of rows) {
    if (row.role === 'event' && !tools) continue;
    const date = new Date(row.at);
    let at = row.at;
    if (Number.isFinite(date.getTime())) {
      const offset = -date.getTimezoneOffset();
      const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
      const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
      const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
      at = `${local}${offset >= 0 ? '+' : '-'}${hours}:${minutes}`;
    }
    const parts = [`## ${row.role === 'user' ? '你' : row.role === 'assistant' ? 'AI' : '工具'}`, safe(at)];
    if (row.role !== 'event') {
      const model = [row.model, row.effort].filter(Boolean).join(' / ');
      if (model) parts.push(`模型／思考：${safe(model)}`);
    }
    parts.push(block(row.text));
    if (row.role === 'user' && row.images?.length) {
      parts.push(`圖片：\n${row.images.map(image => `- ${path.basename(image.replaceAll('\\', '/'))}`).join('\n')}`);
    }
    if (row.role === 'assistant') {
      if (row.stopped) parts.push('（已停止）');
      if (row.error) parts.push('（回覆失敗）');
      if (row.usage) parts.push(`Token：輸入 ${row.usage.input}／輸出 ${row.usage.output}${row.usage.cached === undefined ? '' : `／快取 ${row.usage.cached}`}`);
    }
    sections.push(parts.join('\n\n'));
  }
  return sections.join('\n\n') + '\n';
}

/**
 * A reply cut off mid code block (stopped, failed, interrupted) leaves its fence open, and Markdown would then render
 * every later turn of the export as code. Closing it inside the same message keeps each turn's content in place.
 */
function closeFence(text: string): string {
  let open: { char: string; length: number } | undefined;
  for (const line of text.split('\n')) {
    // CommonMark: up to three spaces of indentation, then at least three backticks or tildes.
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!fence) continue;
    const marker = fence[1]!; const rest = fence[2]!;
    if (!open) { if (marker[0] === '~' || !rest.includes('`')) open = { char: marker[0]!, length: marker.length }; }
    else if (marker[0] === open.char && marker.length >= open.length && !rest.trim()) open = undefined;
  }
  return open ? `${text}${text.endsWith('\n') ? '' : '\n'}${open.char.repeat(open.length)}` : text;
}
