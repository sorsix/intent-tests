import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blend,
  colourName,
  describeColour,
  mentionsColour,
  parseCssColour,
  toHex,
} from '../src/colour.ts';

const name = (css: string) => colourName(parseCssColour(css)!);

test('parses the colour formats getComputedStyle reports', () => {
  assert.deepEqual(parseCssColour('rgb(34, 139, 34)'), { r: 34, g: 139, b: 34, a: 1 });
  assert.deepEqual(parseCssColour('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseCssColour('rgb(53 136 86 / 0.5)'), { r: 53, g: 136, b: 86, a: 0.5 });
  assert.deepEqual(parseCssColour('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseCssColour('#fe994a'), { r: 254, g: 153, b: 74, a: 1 });
  assert.deepEqual(parseCssColour('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseCssColour('linear-gradient(red, blue)'), null);
  assert.equal(parseCssColour('color(display-p3 1 0 0)'), null);
});

test("names an app's status colours and other common ones", () => {
  // A clinic list's status colours and the selected tile's inline colour.
  assert.equal(name('#C7C7C7'), 'grey');
  assert.equal(name('#358856'), 'green');
  assert.equal(name('rgb(34, 139, 34)'), 'green');
  assert.equal(name('#FE994A'), 'orange');
  assert.equal(name('#EA4335'), 'red');
  assert.equal(name('#ffffff'), 'white');
  assert.equal(name('#f4f6f8'), 'white');
  assert.equal(name('#1c2430'), 'black');
  assert.equal(name('#2967BC'), 'blue');
  assert.equal(name('#FFD600'), 'yellow');
  assert.equal(name('#8E44AD'), 'purple');
  assert.equal(name('#E91E63'), 'pink');
  assert.equal(name('#009688'), 'teal');
  assert.equal(name('#c8f7c5'), 'light green');
  assert.equal(name('#0b3d1a'), 'dark green');
});

test('a semi-transparent background is named as it shows over what is behind it', () => {
  const white = parseCssColour('#ffffff')!;
  const tint = blend(parseCssColour('rgba(234, 67, 53, 0.15)')!, white);
  assert.equal(toHex(tint), '#FCE3E1');
  assert.equal(colourName(tint), 'light red');
  assert.equal(describeColour(parseCssColour('rgb(53, 136, 86)')!), 'green #358856');
});

test('statements that talk about colours, as whole words only', () => {
  for (const s of [
    'expect the "Monday, 9 November 2026" tile to be green',
    'expect every occurrence in the Future Events list has the green (active) background, none grey (draft) or orange (cancelled)',
    'expect the conflict cell to be #EA4335',
    'expect the Save button to be coloured',
    'expect the row to be highlighted in a different color',
    'expect the chip to be Gray',
  ])
    assert.equal(mentionsColour(s), true, s);
  for (const s of [
    'expect the page shows "Greenhouse"',
    'expect the page shows "Reddit"',
    'expect the "Save" button is disabled',
    'expect the page shows "Intent CC10 Location", "#12" and "07:30 - 12:00"',
  ])
    assert.equal(mentionsColour(s), false, s);
});
