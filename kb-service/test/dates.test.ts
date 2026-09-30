import { describe, expect, it } from 'vitest';
import { parsePeriod } from '../src/paths/dates.ts';

const MOD = '2026-09-29T13:25:41Z';

describe('parsePeriod: every format seen in the Hilton PBI tree', () => {
  it.each([
    [['Accounting', 'Labor', '2026', '09 - September'], '2026-09-01__Hilton_PBI_Labor_Summary.xlsx', { start: '2026-09-01', end: '2026-09-01', grain: 'day' }],
    [['Accounting', "GL's", '2026'], '01.2026 General_Ledger_Activity_Detail.xlsx', { start: '2026-01-01', end: '2026-01-31', grain: 'month' }],
    [['Accounting', 'Labor', '2026', '07 - July'], 'summary.xlsx', { start: '2026-07-01', end: '2026-07-31', grain: 'month' }],
    [['F&B', 'Inventories', '2026', '8 Aug'], 'count.xlsx', { start: '2026-08-01', end: '2026-08-31', grain: 'month' }],
    [['F&B'], 'F&B Weekly Sales Vs Labor 9.5-9.11.xlsx', { start: '2026-09-05', end: '2026-09-11', grain: 'week' }],
    [['F&B'], 'FB sales comparison October 2025.xlsx', { start: '2025-10-01', end: '2025-10-31', grain: 'month' }],
    [['Guest Scores', 'Stay Experience 2024'], 'Hilton PBI Stay Experience Feb 2024.pdf', { start: '2024-02-01', end: '2024-02-29', grain: 'month' }],
    [['Guest Scores', 'Stay Experience 2024'], 'notes.docx', { start: '2024-01-01', end: '2024-12-31', grain: 'year' }],
    [['m3labor', '2025', '08'], 'labor.xlsx', { start: '2025-08-01', end: '2025-08-31', grain: 'month' }],
    [[], 'Hilton Projects.xlsx', { start: '2026-09-29', end: '2026-09-29', grain: null }],
  ])('%j / %s', (folders, file, expected) => {
    expect(parsePeriod(folders, file, MOD)).toEqual(expected);
  });

  it('does not read month names out of ordinary words', () => {
    expect(parsePeriod(['Marketing'], 'Market Analysis.pdf', MOD).grain).toBeNull();
  });
});
