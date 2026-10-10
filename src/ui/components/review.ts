/** 差異檢視的逐行評論：組成一則交給 AI 的修改指示（純函式，方便測試）。 */
export interface ReviewItem {
  /** 例如 `src/a.ts:12`；已刪除的行用翻譯過的說明。 */
  where: string;
  /** 該行程式碼（不含 diff 的 +/- 前綴）。 */
  code: string;
  comment: string;
}

const CODE_LIMIT = 120;

export function buildReviewPrompt(header: string, items: ReviewItem[]): string {
  const body = items.map(item => {
    const code = item.code.length > CODE_LIMIT ? `${item.code.slice(0, CODE_LIMIT)}…` : item.code;
    const comment = item.comment.trim().split('\n').map(line => `  ${line}`).join('\n');
    return `- ${item.where}\n  \`${code.replaceAll('`', "'")}\`\n${comment}`;
  });
  return `${header}\n\n${body.join('\n\n')}`;
}
