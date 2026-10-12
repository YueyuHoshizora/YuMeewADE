import path from 'node:path';
import type { ChatRow, TaskSections } from '../shared/types.ts';

const RECORD_HEADINGS: [keyof TaskSections, string][] = [['done', '做了什麼'], ['next', '下一步'], ['cautions', '注意'], ['memo', '備註']];

/** `record` is the task file's free-text sections; when any has content it precedes the conversation. */
export function formatTranscript(title: string, rows: ChatRow[], workspaceRoot: string, tools = false, record?: TaskSections): string {
  const safe = (text: string) => text.replaceAll(workspaceRoot, '[工作區]');
  const sections = [`# ${safe(title).replace(/[\r\n]/gu, ' ')}`];
  const filled = record ? RECORD_HEADINGS.filter(([key]) => record[key].length) : [];
  if (filled.length) sections.push(['## 作業紀錄', ...filled.map(([key, heading]) => `### ${heading}\n\n${safe(record![key].join('\n'))}`)].join('\n\n'));
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
    parts.push(safe(row.text));
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
