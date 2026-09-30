import type { TextSection } from '../parse/types.ts';

export const tokens = (s: string) => Math.ceil(s.length / 4);

export interface ChildChunk { ord: number; page: number | null; text: string; tokens: number }
export interface ParentChunk { ord: number; heading: string | null; pageFrom: number | null; pageTo: number | null; text: string; children: ChildChunk[] }
export interface ChunkOptions { parentTarget: number; parentMax: number; childTarget: number; overlap: number }
const DEFAULTS: ChunkOptions = { parentTarget: 1000, parentMax: 1500, childTarget: 200, overlap: 0.15 };

interface Block { heading: string | null; page: number | null; text: string; table: boolean }

const isTable = (t: string) => t.split('\n').every(l => /^\|.*\|$/.test(l.trim()));

/** Splits a markdown table into row groups under `max` tokens, repeating the header rows. */
function splitTable(text: string, max: number): string[] {
  const lines = text.split('\n');
  const header = lines.slice(0, 2), body = lines.slice(2);
  const out: string[] = [];
  let cur: string[] = [];
  for (const row of body) {
    if (cur.length && tokens([...header, ...cur, row].join('\n')) > max) { out.push([...header, ...cur].join('\n')); cur = []; }
    cur.push(row);
  }
  if (cur.length || !out.length) out.push([...header, ...cur].join('\n'));
  return out;
}

/** Word windows of at most `target` tokens; each window repeats the last `overlap` share of the previous one. */
function windows(text: string, target: number, overlap: number): string[] {
  const w = text.split(/\s+/).filter(Boolean);
  if (tokens(w.join(' ')) <= target * 1.5) return [w.join(' ')];
  const out: string[] = [];
  let i = 0;
  while (i < w.length) {
    let j = i, chars = 0;
    while (j < w.length && Math.ceil((chars + w[j].length + (j > i ? 1 : 0)) / 4) <= target) { chars += w[j].length + (j > i ? 1 : 0); j++; }
    if (j === i) j = i + 1;
    out.push(w.slice(i, j).join(' '));
    if (j >= w.length) break;
    i = overlap > 0 ? j - Math.max(1, Math.round((j - i) * overlap)) : j;
  }
  return out;
}

function toBlocks(sections: TextSection[], o: ChunkOptions): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    for (const para of s.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
      const table = isTable(para);
      if (tokens(para) <= o.parentMax) { out.push({ heading: s.heading, page: s.page, text: para, table }); continue; }
      const parts = table ? splitTable(para, o.parentTarget) : windows(para, o.parentTarget, 0);
      for (const p of parts) out.push({ heading: s.heading, page: s.page, text: p, table });
    }
  }
  return out;
}

export function chunkSections(sections: TextSection[], opt: Partial<ChunkOptions> = {}): ParentChunk[] {
  const o = { ...DEFAULTS, ...opt };
  const parents: ParentChunk[] = [];
  let cur: { heading: string | null; blocks: Block[] } | null = null;

  const close = () => {
    if (!cur?.blocks.length) return;
    const pages = cur.blocks.map(b => b.page).filter((p): p is number => p !== null);
    const children: ChildChunk[] = [];
    for (const b of cur.blocks) {
      const parts = b.table ? splitTable(b.text, o.childTarget) : windows(b.text, o.childTarget, o.overlap);
      for (const t of parts) children.push({ ord: children.length, page: b.page, text: t, tokens: tokens(t) });
    }
    parents.push({
      ord: parents.length, heading: cur.heading, pageFrom: pages.length ? Math.min(...pages) : null, pageTo: pages.length ? Math.max(...pages) : null,
      text: cur.blocks.map(b => b.text).join('\n\n'), children,
    });
  };

  for (const b of toBlocks(sections, o)) {
    const size = cur ? tokens(cur.blocks.map(x => x.text).join('\n\n')) : 0;
    const headingChanged = cur && b.heading !== cur.heading && size >= 300;
    if (!cur || headingChanged || size + tokens(b.text) > o.parentTarget) { close(); cur = { heading: b.heading, blocks: [] }; }
    cur.blocks.push(b);
  }
  close();
  return parents;
}
