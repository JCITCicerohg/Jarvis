import { describe, expect, it } from 'vitest';
import { detectHeaderRow, genericNormalize, snake } from '../src/sheets/generic.ts';

describe('detectHeaderRow', () => {
  it('skips title rows and finds the header', () => {
    expect(detectHeaderRow([['Hilton Room Renovations Tracker'], [], ['Room', 'Status', 'Cost'], ['101', 'Done', '1,200']])).toBe(2);
  });
  it('returns -1 when there is no header', () => {
    expect(detectHeaderRow([[1, 2], [3, 4]])).toBe(-1);
  });
});

describe('genericNormalize', () => {
  it('names columns, infers types, parses numbers and dates, drops empty rows and columns', () => {
    const t = genericNormalize([
      ['Tracker'],
      ['Room #', 'Status', 'Cost', null, 'Done On'],
      ['101', 'Done', '1,200', null, '8/1/2026'],
      [null, null, null, null, null],
      ['102', 'Open', '(50.00)', null, null],
    ])!;
    expect(t.columns).toEqual([
      { name: 'room', type: 'number' }, { name: 'status', type: 'text' }, { name: 'cost', type: 'number' }, { name: 'done_on', type: 'date' },
    ]);
    expect(t.rows).toEqual([
      { room: 101, status: 'Done', cost: 1200, done_on: '2026-08-01' },
      { room: 102, status: 'Open', cost: -50, done_on: null },
    ]);
  });

  it('dedupes header names and names blank headers', () => {
    const t = genericNormalize([['Amount', 'Amount', null], [1, 2, 'x']])!;
    expect(t.columns.map(c => c.name)).toEqual(['amount', 'amount_2', 'col_3']);
  });

  it('snake-cases names with apostrophes and symbols', () => {
    expect(snake("GL's Total ($)")).toBe('gls_total');
  });
});
