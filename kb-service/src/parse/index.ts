import { parseDocx } from './docx.ts';
import { parsePdf } from './pdf.ts';
import { parsePptx } from './pptx.ts';
import { parseCsvFile, parseXlsx } from './sheets.ts';
import type { Parsed } from './types.ts';

export async function parseFile(name: string, bytes: Buffer): Promise<Parsed> {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf': return parsePdf(bytes);
    case 'docx': return parseDocx(bytes);
    case 'pptx': return parsePptx(bytes);
    case 'xlsx': case 'xlsm': return parseXlsx(bytes);
    case 'csv': return parseCsvFile(name, bytes);
    case 'txt': case 'md': return { kind: 'text', sections: [{ heading: null, page: null, text: bytes.toString('utf8') }], emptyPages: [] };
    case 'xls': return { kind: 'unsupported', reason: 'legacy .xls workbooks are not supported; save as .xlsx' };
    default: return { kind: 'unsupported', reason: `${ext || 'extensionless'} files are not indexed yet (OCR arrives in Plan 5)` };
  }
}
