import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/parse/types.ts';
import { glActivityDetail, isGlActivityDetail } from '../src/sheets/gl.ts';
import { normalizeSheet } from '../src/sheets/normalize.ts';

const _ = null;
// Column positions mirror the real export: B=Post Date, C=Invoice, G=Reference, I=Detail Description, K=Debit, M=Credit, N=JEID, O=Invoice No, Q=Source.
const GL: Cell[][] = [
  [_, _, _, _, _, 'Hilton Palm Beach Airport'],
  [_, _, _, _, _, 'General Ledger Activity Detail'],
  [_, _, _, _, _, 'From 8/1/2026 to 8/31/2026 for Ledger Accounts 10000.000 to 77777777.000'],
  ['Account #', _, _, _, _, 'Account Name'],
  [_, 'Post Date', 'Invoice ', _, _, _, 'Reference', _, 'Detail Description', _, 'Debit', _, 'Credit', 'JEID', 'Invoice No', _, 'Source'],
  [_, '10050.000', _, _, _, 'Operating Account'],
  [_, '8/1/2026', _, _, _, _, 'Credit Card Daily Report  Amex - Rooms', _, 'Credit Card Deposit', _, '1,632.98', _, _, '2026-08-0041', _, _, 'CMDP'],
  [],
  [_, '8/1/2026', _, _, _, _, 'Manual (Non-Check) Amazon', _, _, _, _, _, '54.98', '2026-08-0969', _, _, 'PWOD'],
  [_, _, _, _, _, 'Total 10050.000', _, _, _, _, '1,632.98', _, '54.98'],
  [_, '10200.000', _, _, _, "Guest Ledger's Clearing"],
  [_, '8/2/2026', _, _, _, _, 'Deposit Daily Report Hilton  Adv. Purchase', _, 'Cash Deposit', _, 652.21, _, _, '2026-08-0043', _, _, 'CMDP'],
];

describe('GL Activity Detail', () => {
  it('recognises the report', () => {
    expect(isGlActivityDetail(GL)).toBe(true);
    expect(isGlActivityDetail([['Room', 'Status'], ['101', 'Done']])).toBe(false);
  });

  it('carries the account onto each entry, parses amounts and dates, and skips totals and spacers', () => {
    const t = glActivityDetail(GL);
    expect(t.period).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(t.columns.map(c => `${c.name}:${c.type}`)).toEqual([
      'account:text', 'account_name:text', 'post_date:date', 'invoice:text', 'reference:text', 'detail_description:text',
      'debit:number', 'credit:number', 'jeid:text', 'invoice_no:text', 'source:text',
    ]);
    expect(t.rows).toEqual([
      { account: '10050.000', account_name: 'Operating Account', post_date: '2026-08-01', invoice: null, reference: 'Credit Card Daily Report  Amex - Rooms', detail_description: 'Credit Card Deposit', debit: 1632.98, credit: null, jeid: '2026-08-0041', invoice_no: null, source: 'CMDP' },
      { account: '10050.000', account_name: 'Operating Account', post_date: '2026-08-01', invoice: null, reference: 'Manual (Non-Check) Amazon', detail_description: null, debit: null, credit: 54.98, jeid: '2026-08-0969', invoice_no: null, source: 'PWOD' },
      { account: '10200.000', account_name: "Guest Ledger's Clearing", post_date: '2026-08-02', invoice: null, reference: 'Deposit Daily Report Hilton  Adv. Purchase', detail_description: 'Cash Deposit', debit: 652.21, credit: null, jeid: '2026-08-0043', invoice_no: null, source: 'CMDP' },
    ]);
  });

  it('normalizes 15,000 entries quickly', () => {
    const big: Cell[][] = [...GL.slice(0, 6)];
    for (let i = 0; i < 15_000; i++) big.push([_, '8/3/2026', _, _, _, _, `Manual (Non-Check) Vendor ${i}`, _, _, _, _, _, '10.00', `J${i}`, _, _, 'PWOD']);
    const t0 = Date.now();
    expect(glActivityDetail(big).rows).toHaveLength(15_000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('normalizeSheet picks GL first, then generic, else null', () => {
    expect(normalizeSheet(GL)?.normalizer).toBe('gl-activity-detail');
    expect(normalizeSheet([['Room', 'Status'], ['101', 'Done']])?.normalizer).toBe('generic');
    expect(normalizeSheet([[1], [2]])).toBeNull();
  });
});
