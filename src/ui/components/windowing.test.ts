import assert from 'node:assert/strict';
import test from 'node:test';
import { HeightWindow } from './windowing.ts';

test('variable offsets and viewport boundaries include overscan', () => {
  const window = new HeightWindow();
  assert.deepEqual(window.range(0, 100), { start: 0, end: 0 });
  window.reset([40, 120, 60, 200]);
  assert.equal(window.total, 420);
  assert.equal(window.offset(2), 160);
  assert.equal(window.indexAt(39), 0);
  assert.equal(window.indexAt(40), 1);
  assert.equal(window.indexAt(10000), 3);
  assert.deepEqual(window.range(170, 30, 20), { start: 1, end: 4 });
});

test('prepend returns the exact shift preserving an anchor within a row', () => {
  const window = new HeightWindow();
  window.reset([80, 200, 30]);
  const scroll = window.offset(1) + 17;
  const shift = window.prepend([50, 90]);
  assert.equal(scroll + shift, window.offset(3) + 17);
  assert.equal(window.indexAt(scroll + shift), 3);
});

test('height changes update later offsets without changing prior ones', () => {
  const window = new HeightWindow();
  window.reset([80, 200, 30]);
  assert.equal(window.update(1, 350), 150);
  assert.equal(window.offset(1), 80);
  assert.equal(window.offset(2), 430);
  assert.equal(window.total, 460);
  assert.equal(window.update(1, 350), 0);
  assert.equal(window.update(1, NaN), 0);
  assert.equal(window.update(20, 50), 0);
});

test('thousands of incremental appends cross tree capacities correctly', () => {
  const window = new HeightWindow();
  let sum = 0;
  for (let i = 0; i < 5000; i++) {
    const height = 40 + i % 200;
    window.append(height);
    sum += height;
    assert.equal(window.total, sum);
    assert.equal(window.indexAt(sum - 1), i);
  }
  assert.ok(window.range(100000, 800).end - window.range(100000, 800).start < 60);
});
