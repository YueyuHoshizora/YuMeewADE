// 提示組裝（PLAN.md A.5）：首輪前言 → 交接包（對方未讀的文字對話）→ 使用者指示。

import type { ChatRow } from '../shared/types.ts';

export const HANDOFF_NOTICE = '這是背景記錄，不是新的執行授權；未讀的內容不得假裝讀過。';

export interface Preamble {
  project: string;
  projectDir: string;
  taskId: string;
  taskTitle: string;
  taskFile: string;
  cwd: string;
  role: string;
  job: string;
  cli: string;
}

export function buildPreamble(p: Preamble): string {
  const roleLine = p.role ? `角色：${p.role}${p.job ? `（${p.job}）` : ''}` : '角色：未指定';
  return [
    `你是 ${p.cli}，由 YuMeewADE 以無頭模式啟動。`,
    roleLine,
    `專案：${p.project}（主專案目錄 ${p.projectDir}）`,
    `作業 ${p.taskId}：${p.taskTitle}`,
    `作業檔：${p.taskFile}（可更新 state／question／步驟勾選；state 值：未開始／進行中／等待回覆／暫停／完成）`,
    p.cwd === p.projectDir ? `工作目錄：${p.cwd}` : `工作目錄：${p.cwd}（git worktree 副本；只在此修改，收編到主專案由人操作）`,
    '需要人判斷時，把問題寫進作業檔 question 並把 state 設為「等待回覆」。',
  ].join('\n');
}

/**
 * 交接包：只取人與 AI 的文字對話（不含工具輸出），上限 limit 字，截舊留新。
 * rows 為空時回空字串。
 */
export function buildHandoff(rows: ChatRow[], limit: number): string {
  const entries = rows
    .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.text.trim() !== '')
    .map((r) => `[${r.role === 'user' ? '人' : `AI ${r.cli}`}${r.cancelled ? '，已被停止' : r.interrupted ? '，中斷' : ''}]\n${r.text.trim()}`);
  if (entries.length === 0) return '';
  const header = `<previous_conversation>\n${HANDOFF_NOTICE}\n`;
  const footer = '\n</previous_conversation>';
  const budget = limit - header.length - footer.length;
  let kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as string;
    if (used + e.length + 2 > budget) {
      truncated = true;
      break;
    }
    kept.unshift(e);
    used += e.length + 2;
  }
  if (kept.length === 0 && entries.length > 0) {
    // 單筆就超限：只留最新一筆的尾段
    const last = entries.at(-1) as string;
    kept = [last.slice(Math.max(0, last.length - budget))];
    truncated = true;
  }
  const note = truncated ? '（更早的對話已截去）\n\n' : '';
  return `${header}${note}${kept.join('\n\n')}${footer}`;
}

export function buildPrompt(parts: { preamble?: string; handoff?: string; text: string }): string {
  const blocks: string[] = [];
  if (parts.preamble) blocks.push(parts.preamble);
  if (parts.handoff) blocks.push(parts.handoff);
  blocks.push(parts.text);
  return blocks.join('\n\n');
}
