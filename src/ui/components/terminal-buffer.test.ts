import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalBuffer } from './terminal-buffer.ts';
import { terminalKey, terminalPaste } from './terminal-input.ts';

const text = (screen: TerminalBuffer) => screen.grid.map(line => line.map(cell => cell.char).join(''));
test('all UTF-16 chunk boundaries preserve VT, OSC, Unicode and reports', () => {
  const source = '\x1b[2J\x1b[2;3H\x1b[38;2;12;34;56mA界e\u0301👩🏽‍💻🇯🇵\x1b]52;c;ZXZpbA==\x1b\\\x1bPignored\x1b\\\x1b[6n';
  const baseline = new TerminalBuffer(30, 4); const expectedReplies: string[] = []; baseline.onReply = value => expectedReplies.push(value); baseline.write(source);
  for (let split = 0; split <= source.length; split++) {
    const actual = new TerminalBuffer(30, 4); const replies: string[] = []; actual.onReply = value => replies.push(value);
    actual.write(source.slice(0, split)); actual.write(source.slice(split));
    assert.deepEqual(actual.grid, baseline.grid, `split ${split}`); assert.deepEqual(replies, expectedReplies); assert.equal(actual.x, baseline.x);
  }
  const single = new TerminalBuffer(30, 4); for (const unit of source.split('')) single.write(unit);
  assert.deepEqual(single.grid, baseline.grid);
  assert.equal(baseline.grid[1]![5]!.char, 'é'); assert.equal(baseline.grid[1]![6]!.char, '👩🏽‍💻');
  assert.equal(baseline.grid[1]![6]!.width, 2); assert.equal(baseline.grid[1]![8]!.char, '🇯🇵');
  assert.equal(baseline.grid[1]![2]!.fg, 'rgb(12,34,56)');
});
test('origin mode and margins constrain scrolling without touching outside lines', () => {
  const screen = new TerminalBuffer(8, 4);
  screen.write('HEADER\x1b[4;1HFOOTER\x1b[2;3r\x1b[?6h1\r\n2\r\n3\x1b[6n');
  assert.deepEqual(text(screen), ['HEADER  ', '2       ', '3       ', 'FOOTER  ']); assert.equal(screen.history.length, 0);
  const replies: string[] = []; screen.onReply = value => replies.push(value); screen.write('\x1b[6n\x1b[?6l\x1b[H\x1b[6n');
  assert.deepEqual(replies, ['\x1b[2;2R', '\x1b[1;1R']);
});
test('alternate screen restores main cursor, rendition and history across resize', () => {
  const screen = new TerminalBuffer(8, 3); screen.write('one\r\ntwo\r\nthree\r\n\x1b[31mM\x1b7');
  const history = screen.history.map(line => line.map(cell => cell.char).join(''));
  screen.write('\x1b[?1049hALT\x1b[2;2H\x1b7\x1b[32mX'); screen.resize(10, 4);
  screen.write('\x1b[?1049lN\x1b8Q');
  assert.deepEqual(screen.history.map(line => line.map(cell => cell.char).join('')), history);
  assert.equal(screen.grid[2]![0]!.char, 'M'); assert.equal(screen.grid[2]![1]!.char, 'Q'); assert.equal(screen.grid[2]![1]!.fg, '#cc6666');
  assert.equal(screen.alternate, false); assert.equal(screen.grid.length, 4); assert.equal(screen.grid[0]!.length, 10);
});
test('insert/delete characters and lines, reverse index and region scroll', () => {
  const screen = new TerminalBuffer(8, 4); screen.write('abcdef\x1b[1;3H\x1b[2@XY\x1b[1;4H\x1b[2P');
  assert.equal(text(screen)[0], 'abXdef  ');
  screen.write('\x1b[4h\x1b[1;2HZ\x1b[4l'); assert.equal(text(screen)[0], 'aZbXdef ');
  screen.write('\x1b[2;1H222\x1b[3;1H333\x1b[4;1H444\x1b[2;4r\x1b[2;1H\x1b[L');
  assert.deepEqual(text(screen).slice(1), ['        ', '222     ', '333     ']);
  screen.write('\x1b[M\x1bM'); assert.deepEqual(text(screen).slice(1), ['        ', '222     ', '333     ']);
  screen.write('\x1b[S'); assert.deepEqual(text(screen).slice(1), ['222     ', '333     ', '        ']);
});
test('wide-cell erasure and resize never leave orphan continuations', () => {
  const screen = new TerminalBuffer(6, 2); screen.write('A界B\x1b[1;3H\x1b[X'); assert.equal(text(screen)[0], 'A  B  ');
  screen.write('\x1b[1;5H界'); screen.resize(5, 2); assert.equal(screen.grid[0]![4]!.char, ' ');
  for (const line of screen.grid) for (let x = 0; x < line.length; x++) if (line[x]!.width === 0) assert.equal(line[x - 1]?.width, 2);
});
test('tabs, DEC graphics, autowrap and erase-scrollback are stateful', () => {
  const screen = new TerminalBuffer(12, 2); screen.write('\x1b[3g\x1b[1;5H\x1bH\r\tX'); assert.equal(screen.grid[0]![4]!.char, 'X');
  screen.write('\x1b[2;1H\x1b(0lqk\x1b(B'); assert.equal(text(screen)[1]!.slice(0, 3), '┌─┐');
  screen.write('\x1b[?7l\x1b[1;12HAB'); assert.equal(screen.grid[0]![11]!.char, 'B'); assert.equal(screen.y, 0);
  screen.write('\x1b[?7h\x1b[2;12HC\x1b[31mD'); assert.equal(screen.history.length, 1); assert.equal(screen.grid[1]![0]!.char, 'D');
  const before = text(screen); screen.write('\x1b[3J'); assert.equal(screen.history.length, 0); assert.deepEqual(text(screen), before);
});
test('parser overflow discards sequence instead of displaying attacker-controlled suffix', () => {
  const screen = new TerminalBuffer(12, 2); screen.write('\x1b[' + '1;'.repeat(10000)); screen.write('mSAFE\x1b]8;;https://evil.example\x1b\\TEXT\x1b]52;c;secret\x07!');
  assert.equal(text(screen)[0], 'SAFETEXT!   ');
  screen.write('\x1b[123\x18OK'); assert.equal(text(screen)[0], 'SAFETEXT!OK ');
});
test('reports, modifier keys, interrupt and safe bracketed paste use PTY wire format', () => {
  const screen = new TerminalBuffer(8, 3); const replies: string[] = []; screen.onReply = value => replies.push(value);
  screen.write('\x1b[5n\x1b[c\x1b[3;4H\x1b[6n'); assert.deepEqual(replies, ['\x1b[0n', '\x1b[?1;2c', '\x1b[3;4R']);
  const key = { key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false };
  assert.equal(terminalKey(key, false), '\x03'); assert.equal(terminalKey({ ...key, key: 'ArrowLeft' }, true), '\x1b[1;5D');
  assert.equal(terminalKey({ ...key, key: 'Home', ctrlKey: false }, true), '\x1bOH');
  assert.equal(terminalKey({ ...key, shiftKey: true }, false), undefined);
  assert.equal(terminalPaste('a\n\x1b[201~b', true), '\x1b[200~a\r[201~b\x1b[201~');
});
test('AltGr characters reach the shell as text; a real Ctrl+Alt chord still sends ESC plus the control code', () => {
  const chord = { key: '@', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false };
  // Windows reports AltGr+Q (German) as Ctrl+Alt with AltGraph set: the input event must deliver "@".
  assert.equal(terminalKey({ ...chord, getModifierState: key => key === 'AltGraph' }, false), undefined);
  assert.equal(terminalKey({ ...chord, getModifierState: () => false }, false), '\x1b\0');
  assert.equal(terminalKey({ ...chord, key: 'ArrowLeft', getModifierState: key => key === 'AltGraph' }, false), '\x1b[1;7D');
});
test('CNL and CPL stop at the scrolling margins like CUD and CUU', () => {
  const down = new TerminalBuffer(4, 4); down.write('\x1b[2;3r\x1b[3;1H\x1b[E!');
  assert.deepEqual(text(down), ['    ', '    ', '!   ', '    ']);
  const up = new TerminalBuffer(4, 4); up.write('\x1b[2;3r\x1b[2;1H\x1b[F!');
  assert.deepEqual(text(up), ['    ', '!   ', '    ', '    ']);
});
test('DECRC restores autowrap and the saved character set designation', () => {
  const wrap = new TerminalBuffer(4, 2); wrap.write('\x1b7\x1b[?7l\x1b8ABCDE');
  assert.deepEqual(text(wrap), ['ABCD', 'E   ']);
  // ESC(0 selects DEC line drawing for G0; ESC(B after the save must be undone by the restore.
  const charset = new TerminalBuffer(4, 2); charset.write('\x1b(0\x1b7\x1b(B\x1b8q');
  assert.equal(text(charset)[0], '─   ');
});
test('designating G0 or G1 does not change which register SO/SI selected', () => {
  // SO selects G1 (DEC graphics); redesignating G0 must leave G1 in use.
  const keep = new TerminalBuffer(8, 2); keep.write('\x1b)0\x0eq\x1b(Bq');
  assert.equal(text(keep)[0], '──      ');
  // While G1 is selected, redesignating G1 itself takes effect at once; SI then returns to plain G0.
  const change = new TerminalBuffer(8, 2); change.write('\x1b)B\x0eq\x1b)0q\x0fq');
  assert.equal(text(change)[0], 'q─q     ');
});
test('late emoji presentation wraps a complete grapheme at the right edge', () => {
  const screen = new TerminalBuffer(4, 2); screen.write('abc❤'); screen.write('\uFE0F');
  assert.equal(text(screen)[0], 'abc '); assert.equal(screen.grid[1]![0]!.char, '❤️');
  assert.equal(screen.grid[1]![0]!.width, 2); assert.equal(screen.grid[1]![1]!.width, 0);
  assert.equal(screen.x, 2);
});
test('discarded DCS cannot end at BEL, and scrollback remains bounded', () => {
  const screen = new TerminalBuffer(4, 2); screen.write('\x1bPpayload\x07hidden\x1b\\OK');
  assert.equal(text(screen)[0], 'OK  ');
  screen.write('\r\n'.repeat(2010)); assert.equal(screen.history.length, 2000);
  screen.write('\x1b[?1049h' + '\r\n'.repeat(20)); assert.equal(screen.history.length, 2000);
});
