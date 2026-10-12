import type { Ask } from '../shared/types.ts';

/** Markdown code: fenced blocks (an unclosed fence runs to the end, as in CommonMark), then inline spans on one line. */
const FENCE = /^ {0,3}((`|~)\2{2,})[^\n]*(?:\n(?:[\s\S]*?\n)?? {0,3}\1\2*[ \t]*(?=\n|$)|[\s\S]*)/gmu;
const INLINE = /(`+)(?:[^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/gu;
const SLOT = /\uE000(\d+)\uE001/gu;

/**
 * Question tags quoted in code (an AI explaining the format) are content, not a live question: code is set aside before
 * parsing and put back verbatim afterwards.
 */
export function parseAsk(text: string): { text: string; asks: Ask[] } {
  const code: string[] = [];
  // Private-use slot markers; text that already contains them is parsed unmasked rather than risk a wrong restore.
  const maskable = !/[\uE000\uE001]/u.test(text);
  const mask = (value: string, pattern: RegExp): string => value.replace(pattern, match => `\uE000${code.push(match) - 1}\uE001`);
  // An inline span can only enclose a fence slot in pathological input; a second pass restores that level too.
  const put = (value: string): string => value.replace(SLOT, (_, index: string) => code[Number(index)]!);
  const restore = (value: string): string => put(put(value));
  const source = maskable ? mask(mask(text, FENCE), INLINE) : text;
  const asks: Ask[] = [];
  const visible = source.replace(
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
        question: restore(question), options: options.map(restore),
        multi: /[（(](?:可複選|multi|複数可)[）)]/iu.test(question),
      });
      return remaining.length ? `\n${remaining.join('\n')}\n` : '';
    },
  );
  return { text: restore(visible).trim(), asks };
}

/** Plain-text form of a parsed question for exports and handoffs; `multi` is already spelled out in the question itself. */
export function formatAsk(ask: Ask): string {
  return [`提問：${ask.question}`, ...ask.options.map((option, index) => `${index + 1}. ${option}`)].join('\n');
}
