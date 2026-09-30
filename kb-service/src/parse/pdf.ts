import { extractText, getDocumentProxy } from 'unpdf';
import type { Parsed } from './types.ts';

export async function parsePdf(bytes: Buffer): Promise<Parsed> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  const pages = text as string[];
  const sections = pages
    .map((t, i) => ({ heading: null, page: i + 1, text: t.replace(/[ \t]+\n/g, '\n').trim() }))
    .filter(s => s.text);
  const emptyPages = pages.flatMap((t, i) => (t.trim() ? [] : [i + 1]));
  return { kind: 'text', sections, emptyPages };
}
