import { describe, expect, it } from 'vitest';
import { clickRisk, irreversibleReason, sqlWriteReason } from './risk.ts';

describe('irreversibleReason', () => {
  it.each([
    'Remove-Item -Recurse C:\\x',
    'Remove-Item C:\\x -Recurse -Force',
    'rm -rf ./build',
    'rmdir /s /q C:\\tmp',
    'Get-ChildItem C:\\logs -Recurse | Remove-Item',
    'Format-Volume -DriveLetter D',
    'format D: /q',
    'reg delete HKCU\\Software\\X /f',
    'Remove-Item HKCU:\\Software\\X',
    'git push --force',
    'git push origin main -f',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'Clear-RecycleBin -Force',
  ])('flags %s', cmd => {
    expect(irreversibleReason(cmd)).not.toBeNull();
  });

  it.each([
    'Get-ChildItem',
    'Get-ChildItem -Recurse C:\\Users | Sort-Object Length -Descending | Select-Object -First 5',
    'Get-Process | Format-Table',
    'Remove-Item C:\\temp\\a.txt',
    'git push origin main',
    'git reset HEAD file.txt',
    'winget install jqlang.jq',
    'npm run build',
  ])('allows %s', cmd => {
    expect(irreversibleReason(cmd)).toBeNull();
  });
});

describe('clickRisk', () => {
  it.each([
    ['Pay $4,386.20', 'Pay'], ['Place order', 'Pay'], ['Checkout', 'Pay'],
    ['Delete', 'Delete'], ['Remove file', 'Delete'], ['Move to trash', 'Delete'],
    ['Send', 'Send'], ['Reply all', 'Send'], ['Post', 'Send'], ['Share', 'Send'],
  ])('%s → %s', (label, risk) => {
    expect(clickRisk(label)).toBe(risk);
  });

  it.each(['Search', 'Export', 'Next', 'Inventory', 'Counts', 'Sign in', 'Download CSV', 'Payroll report', 'Sender'])('allows %s', label => {
    expect(clickRisk(label)).toBeNull();
  });
});

describe('sqlWriteReason', () => {
  it('flags COPY TO, EXPORT and ATTACH', () => {
    expect(sqlWriteReason("COPY t TO 'out.csv'")).not.toBeNull();
    expect(sqlWriteReason("EXPORT DATABASE 'dir'")).not.toBeNull();
    expect(sqlWriteReason("ATTACH 'x.duckdb' AS x")).not.toBeNull();
  });
  it('allows reads', () => {
    expect(sqlWriteReason("SELECT * FROM read_csv_auto('C:/a.csv') WHERE copy_count > 1")).toBeNull();
    expect(sqlWriteReason('SUMMARIZE SELECT 1')).toBeNull();
  });
});
