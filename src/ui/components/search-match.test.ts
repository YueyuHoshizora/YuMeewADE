import assert from 'node:assert/strict';
import test from 'node:test';
import { searchParts } from './search-match.ts';
test('highlighting preserves untrusted text and matches literal punctuation', () => {
  const text = '<img onerror=x> a.b A.B';
  const parts = searchParts(text, 'a.b');
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.match).map(part => part.text), ['a.b', 'A.B']);
  assert.deepEqual(searchParts(text, ''), [{ text, match: false }]);
  assert.deepEqual(searchParts('a[bc] a+b $', '[bc]').filter(part => part.match).map(part => part.text), ['[bc]']);
});
test('case insensitive Unicode matching preserves original offsets', () => {
  assert.deepEqual(searchParts('İ ß ABC abc', 'abc').filter(part => part.match).map(part => part.text), ['ABC', 'abc']);
});
test('a character whose lowercase form is longer highlights whole, as the conversation search matched it', () => {
  const parts = searchParts('İstanbul ist', 'i');
  assert.equal(parts.map(part => part.text).join(''), 'İstanbul ist');
  assert.deepEqual(parts.filter(part => part.match).map(part => part.text), ['İ', 'i']);
  assert.deepEqual(searchParts('İSTANBUL', 'i̇s').filter(part => part.match).map(part => part.text), ['İS']);
});
