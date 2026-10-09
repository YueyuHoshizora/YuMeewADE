import type { Ask } from '../shared/types.ts';
export function parseAsk(text: string): { text: string; asks: Ask[] } {
  const asks: Ask[] = [];
  const visible = text.replace(/\[\[(question|質問|問題)\]\]([\s\S]*?)(?:\[\[\/\1\]\]|$)/gu, (_block, _tag: string, body: string) => {
    const questions: string[] = []; const options: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim(); if (!line) continue;
      const option = /^(?:\d+[.)、．]|[-*•])\s*(.+)$/u.exec(line);
      if (option) options.push(option[1] ?? ''); else if (!options.length) questions.push(line);
    }
    const question = questions.join('\n');
    if (question) asks.push({ question, options: options.slice(0, 8), multi: /[（(](?:可複選|multi|複数可)[）)]/iu.test(question) });
    return '';
  });
  return { text: visible.trim(), asks };
}
