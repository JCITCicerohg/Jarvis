import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { parseFile } from '../src/parse/index.ts';

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Cleanliness score 92 in August', { x: 50, y: 700, font, size: 12 });
  doc.addPage();
  return Buffer.from(await doc.save());
}

async function docx(): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: 'Revenue', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('Revenue grew 8% on last year.'),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [new Paragraph('Month')] }), new TableCell({ children: [new Paragraph('Total')] })] }),
      new TableRow({ children: [new TableCell({ children: [new Paragraph('Aug')] }), new TableCell({ children: [new Paragraph('120')] })] }),
    ] }),
  ] }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function pptx(): Promise<Buffer> {
  const zip = new JSZip();
  const slide = (t: string) => `<p:sld xmlns:a="a" xmlns:p="p"><a:t>${t}</a:t><a:t>&amp; more</a:t></p:sld>`;
  zip.file('ppt/slides/slide2.xml', slide('Second'));
  zip.file('ppt/slides/slide10.xml', slide('Tenth'));
  zip.file('ppt/slides/slide1.xml', slide('First'));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Date', 'Amount', 'Note']);
  ws.addRow([new Date(Date.UTC(2026, 7, 1)), 1632.98, { richText: [{ text: 'Amex ' }, { text: 'Rooms' }] }]);
  ws.getCell('B3').value = { formula: 'B2*2', result: 3265.96 };
  wb.addWorksheet('Empty');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseFile', () => {
  it('reads PDF text per page and reports empty pages', async () => {
    const p = await parseFile('report.pdf', await pdf());
    if (p.kind !== 'text') throw new Error('expected text');
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0]).toMatchObject({ page: 1, heading: null });
    expect(p.sections[0].text).toContain('Cleanliness score 92');
    expect(p.emptyPages).toEqual([2]);
  });

  it('reads Word headings, paragraphs and tables as markdown', async () => {
    const p = await parseFile('memo.docx', await docx());
    if (p.kind !== 'text') throw new Error('expected text');
    expect(p.sections[0].heading).toBe('Revenue');
    expect(p.sections[0].text).toContain('Revenue grew 8% on last year.');
    expect(p.sections[0].text).toContain('| Month | Total |\n| --- | --- |\n| Aug | 120 |');
  });

  it('reads PowerPoint slides in numeric order', async () => {
    const p = await parseFile('deck.pptx', await pptx());
    if (p.kind !== 'text') throw new Error('expected text');
    expect(p.sections.map(s => s.heading)).toEqual(['Slide 1', 'Slide 2', 'Slide 10']);
    expect(p.sections[0].text).toBe('First & more');
  });

  it('reads Excel sheets as plain cell values and skips empty sheets', async () => {
    const p = await parseFile('book.xlsx', await xlsx());
    if (p.kind !== 'sheets') throw new Error('expected sheets');
    expect(p.sheets.map(s => s.name)).toEqual(['Sheet1']);
    expect(p.sheets[0].rows).toEqual([['Date', 'Amount', 'Note'], ['2026-08-01', 1632.98, 'Amex Rooms'], [null, 3265.96]]);
  });

  it('reads CSV and marks unknown types unsupported', async () => {
    const p = await parseFile('data.csv', Buffer.from('a,b\n1,2\n'));
    expect(p).toEqual({ kind: 'sheets', sheets: [{ name: 'data', rows: [['a', 'b'], ['1', '2']] }] });
    expect(await parseFile('photo.jpg', Buffer.from([1]))).toEqual({ kind: 'unsupported', reason: 'jpg files are not indexed yet (OCR arrives in Plan 5)' });
    expect((await parseFile('old.xls', Buffer.from([1]))).kind).toBe('unsupported');
  });
});
