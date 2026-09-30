import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../src/config.ts';
import { contextHeader, deriveMeta, stripDates } from '../src/paths/metadata.ts';

const SRC: SourceConfig = {
  id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI',
  drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true,
};
const MOD = '2026-09-29T13:25:41Z';

describe('stripDates', () => {
  it.each([
    ['Stay Experience 2024', 'Stay Experience'],
    ['FB sales comparison October 2025', 'FB sales comparison'],
    ['F&B Weekly Sales Vs Labor 9.5-9.11', 'F&B Weekly Sales Vs Labor'],
    ['01.2026 General_Ledger_Activity_Detail', 'General_Ledger_Activity_Detail'],
    ['2026-09-01__Hilton_PBI_Labor_Summary', 'Hilton_PBI_Labor_Summary'],
    ["GL's", "GL's"],
  ])('%s → %s', (a, b) => expect(stripDates(a)).toBe(b));
});

describe('deriveMeta', () => {
  it('maps department and dataset levels and keeps apostrophes', () => {
    const m = deriveMeta(SRC, ['Accounting', "GL's", '2026'], '08.2026 General_Ledger_Activity_Detail.xlsx', MOD);
    expect(m).toMatchObject({
      business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', department: 'Accounting', dataset: "GL's",
      period: { start: '2026-08-01', end: '2026-08-31', grain: 'month' }, pathSegments: ['Accounting', "GL's", '2026'], fileType: 'xlsx',
    });
  });

  it('strips years from a dataset folder name', () => {
    expect(deriveMeta(SRC, ['Guest Scores', 'Stay Experience 2024'], 'x.pdf', MOD).dataset).toBe('Stay Experience');
  });

  it('uses the file name as dataset for loose files', () => {
    expect(deriveMeta(SRC, [], 'Hilton Projects.xlsx', MOD)).toMatchObject({ department: null, dataset: 'Hilton Projects' });
    expect(deriveMeta(SRC, ['F&B'], 'FB sales comparison October 2025.xlsx', MOD)).toMatchObject({ department: 'F&B', dataset: 'FB sales comparison' });
  });

  it('builds a readable context header', () => {
    const m = deriveMeta(SRC, ['Guest Scores', 'Stay Experience 2024'], 'Hilton PBI Stay Experience August 2024.pdf', MOD);
    expect(contextHeader(m, 'Cleanliness')).toBe('Hilton Palm Beach PBI › Guest Scores › Stay Experience › Aug 2024 › Cleanliness');
  });
});
