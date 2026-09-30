import mammoth from 'mammoth';
import type { Parsed, TextSection } from './types.ts';

const strip = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

function tableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => strip(c[1]).replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const line = (r: string[]) => '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
}

/** Headings start sections; paragraphs and lists become text; tables become markdown tables. */
export async function parseDocx(bytes: Buffer): Promise<Parsed> {
  const { value: html } = await mammoth.convertToHtml({ buffer: bytes });
  const sections: TextSection[] = [];
  let cur: TextSection = { heading: null, page: null, text: '' };
  const flush = () => { cur.text = cur.text.trim(); if (cur.text || cur.heading) sections.push(cur); };
  for (const m of html.matchAll(/<(h[1-6]|p|li|table)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tag = m[1];
    if (tag.startsWith('h')) { flush(); cur = { heading: strip(m[2]), page: null, text: '' }; }
    else if (tag === 'table') cur.text += '\n\n' + tableToMarkdown(m[2]) + '\n\n';
    else { const t = strip(m[2]); if (t) cur.text += (tag === 'li' ? '- ' : '') + t + '\n\n'; }
  }
  flush();
  return { kind: 'text', sections: sections.filter(s => s.text), emptyPages: [] };
}
