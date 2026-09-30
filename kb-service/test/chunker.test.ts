import { describe, expect, it } from 'vitest';
import { chunkSections, tokens } from '../src/chunk/chunker.ts';

const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

describe('chunkSections', () => {
  it('keeps a short section as one parent with one child', () => {
    const p = chunkSections([{ heading: 'Intro', page: 1, text: 'Short text.' }]);
    expect(p).toEqual([{ ord: 0, heading: 'Intro', pageFrom: 1, pageTo: 1, text: 'Short text.', children: [{ ord: 0, page: 1, text: 'Short text.', tokens: 3 }] }]);
  });

  it('splits long text into ~200-token children with overlap, and parents under the max', () => {
    const p = chunkSections([{ heading: null, page: 1, text: words(3000) }]);
    for (const parent of p) expect(tokens(parent.text)).toBeLessThanOrEqual(1500);
    const kids = p.flatMap(x => x.children);
    for (const k of kids) expect(k.tokens).toBeLessThanOrEqual(201);
    const [a, b] = [kids[0].text.split(' '), kids[1].text.split(' ')];
    const shared = a.slice(-Math.round(a.length * 0.15));
    expect(shared.length).toBeGreaterThan(0);
    expect(b.slice(0, shared.length)).toEqual(shared);
  });

  it('never splits a table mid-row and repeats the header', () => {
    const header = '| Month | Total |\n| --- | --- |';
    const rows = Array.from({ length: 400 }, (_, i) => `| M${i} | ${i * 10} |`).join('\n');
    const p = chunkSections([{ heading: 'Table', page: 2, text: `${header}\n${rows}` }]);
    const kids = p.flatMap(x => x.children);
    expect(kids.length).toBeGreaterThan(1);
    for (const k of kids) {
      expect(k.text.startsWith(header)).toBe(true);
      for (const line of k.text.split('\n')) expect(line).toMatch(/^\|.*\|$/);
    }
    expect(kids.flatMap(k => k.text.split('\n').slice(2))).toHaveLength(400);
  });

  it('merges small sections under one heading run and tracks page ranges', () => {
    const p = chunkSections([
      { heading: 'A', page: 1, text: 'one' },
      { heading: 'A', page: 2, text: 'two' },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ heading: 'A', pageFrom: 1, pageTo: 2, text: 'one\n\ntwo' });
  });
});
