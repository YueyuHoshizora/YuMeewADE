import type { Ask } from '../shared/types.ts';

export function parseAsk(text: string): { text: string; asks: Ask[] } {
  const asks: Ask[] = [];
  // Only consume explicitly closed blocks: an incomplete reply must remain visible.
  const visible = text.replace(
    /\[\[(question|質問|問題)\]\]([\s\S]*?)\[\[\/\1\]\]/gu,
    (block: string, _tag: string, body: string) => {
      const questions: string[] = [];
      const options: string[] = [];
      const remaining: string[] = [];
      for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const option = /^(?:\d+[.)、．]|[-*•])\s*(.+)$/u.exec(line);
        if (option) options.push(option[1] ?? '');
        else if (!options.length) questions.push(line);
        else remaining.push(raw);
      }
      const question = questions.join('\n');
      if (!question) return block;
      asks.push({
        question, options,
        multi: /[（(](?:可複選|multi|複数可)[）)]/iu.test(question),
      });
      return remaining.length ? `\n${remaining.join('\n')}\n` : '';
    },
  );
  return { text: visible.trim(), asks };
}
