import type { Ask } from '../shared/types.ts';

export function parseAsk(text: string): { text: string; asks: Ask[] } {
  const asks: Ask[] = [];
  const visible = text.replace(
    /\[\[(question|質問|問題)\]\]([\s\S]*?)(\[\[\/\1\]\]|$)/gu,
    (block: string, _tag: string, body: string, closing: string) => {
      const questions: string[] = [];
      const options: string[] = [];
      const remaining: string[] = [];
      const lines = body.split('\n');
      // A missing closing tag may end an otherwise valid ask. Consume only
      // its first paragraph/option list, never the unrelated prose after it.
      if (!closing && /\[\[\/(?:question|質問|問題)\]\]/u.test(body)) return block;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const line = raw.trim();
        if (!line) {
          if (!closing && (questions.length || options.length)) {
            const next = lines.slice(i + 1).find(value => value.trim());
            if (!next || !/^(?:\d+[.)、．]|[-*•])\s*(.+)$/u.test(next.trim())) {
              remaining.push(...lines.slice(i));
              break;
            }
          }
          continue;
        }
        const option = /^(?:\d+[.)、．]|[-*•])\s*(.+)$/u.exec(line);
        if (option) options.push(option[1] ?? '');
        else if (!options.length) questions.push(line);
        else if (!closing) {
          remaining.push(...lines.slice(i));
          break;
        } else remaining.push(raw);
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

/** Plain-text form of a parsed question for exports and handoffs; `multi` is already spelled out in the question itself. */
export function formatAsk(ask: Ask): string {
  return [`提問：${ask.question}`, ...ask.options.map((option, index) => `${index + 1}. ${option}`)].join('\n');
}
