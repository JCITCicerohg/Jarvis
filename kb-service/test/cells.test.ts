import { describe, expect, it } from 'vitest';
import { cellValue, parseCsv, toIsoDate, toNumber } from '../src/parse/cells.ts';

describe('cellValue', () => {
  it('flattens exceljs cell shapes', () => {
    expect(cellValue({ formula: 'SUM(A1:A2)', result: 12.5 })).toBe(12.5);
    expect(cellValue({ richText: [{ text: 'Credit ' }, { text: 'Card' }] })).toBe('Credit Card');
    expect(cellValue({ text: 'Link', hyperlink: 'https://x' })).toBe('Link');
    expect(cellValue(new Date(Date.UTC(2026, 7, 1)))).toBe('2026-08-01');
    expect(cellValue({ error: '#REF!' })).toBeNull();
    expect(cellValue('  x  ')).toBe('x');
    expect(cellValue('')).toBeNull();
    expect(cellValue(undefined)).toBeNull();
  });
});

describe('toNumber / toIsoDate', () => {
  it.each([['1,632.98', 1632.98], ['$1,200', 1200], ['(12.50)', -12.5], ['-3', -3], ['45%', 45], [7, 7], ['abc', null], ['2026-08-01', null]])('%s', (a, b) => {
    expect(toNumber(a as string | number)).toBe(b);
  });
  it.each([['8/1/2026', '2026-08-01'], ['2026-08-01', '2026-08-01'], ['12/31/2025', '2025-12-31'], ['13/40/2025', null], ['hello', null]])('%s', (a, b) => {
    expect(toIsoDate(a)).toBe(b);
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, quotes and newlines', () => {
    expect(parseCsv('a,b\n"1,5","say ""hi"""\n"x\ny",2\n')).toEqual([['a', 'b'], ['1,5', 'say "hi"'], ['x\ny', '2']]);
  });
});
