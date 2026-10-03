import { describe, expect, test } from 'vitest';
import { drawerRows, pickerBodyRows, pickerContentRows } from '../plugins/buddy/src/drawer.ts';

describe('drawerRows', () => {
  test.each([50, 80])('leaves the inline picker and prompt visible at %i terminal rows', (rows) => {
    expect(drawerRows(rows, 11, false)).toBe(rows - 11 - 2 - 6);
  });
  test('a taller rebuilt picker gets its body rows too', () => {
    expect(drawerRows(50, 20, false)).toBe(22);
  });
  test('no picker or a fullscreen dock leaves the whole band to the drawer', () => {
    expect(drawerRows(50, 0, false)).toBe(50);
    expect(drawerRows(50, 20, true)).toBe(50);
  });
  test('a small band keeps the drawer controls, within its own ceiling', () => {
    expect(drawerRows(24, 20, false)).toBe(10);
    expect(drawerRows(8, 20, false)).toBe(8);
  });
});

describe('pickerBodyRows', () => {
  test('the first list keeps its group and button positions before measurement; a granted short body still windows it', () => {
    expect(pickerBodyRows(11, 0)).toBe(11);
    expect(pickerBodyRows(11, 5)).toBe(5);
  });
});

describe('pickerContentRows', () => {
  test.each([0, 3])('a first body of %i rows grows to the requested list, rather than measuring itself short forever', (initial) => {
    let measured = initial;
    for (let n = 0; n < 3; n++) measured = Math.min(11, pickerContentRows(11, measured));
    expect(measured).toBe(11);
  });
  test('a body resized taller by the person keeps its visible rows', () => {
    expect(pickerContentRows(11, 20)).toBe(20);
  });
});
