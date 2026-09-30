import JSZip from 'jszip';
import type { Parsed } from './types.ts';

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function parsePptx(bytes: Buffer): Promise<Parsed> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map(n => ({ n, i: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0) }))
    .filter(s => s.i > 0)
    .sort((a, b) => a.i - b.i);
  const sections = [];
  for (const s of slides) {
    const xml = await zip.file(s.n)!.async('string');
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decode(m[1]).trim()).filter(Boolean).join(' ');
    if (text) sections.push({ heading: `Slide ${s.i}`, page: s.i, text });
  }
  return { kind: 'text', sections, emptyPages: [] };
}
