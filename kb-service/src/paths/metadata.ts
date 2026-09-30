import type { SourceConfig } from '../config.ts';
import { monthWord, parsePeriod, type Period } from './dates.ts';

export interface DocMeta {
  business: string; hotel: string | null; department: string | null; dataset: string | null;
  period: Period; pathSegments: string[]; fileType: string;
}

/** Removes dates, years, month words and numeric date patterns from a name. */
export function stripDates(s: string): string {
  return s
    .replace(/20\d{2}-\d{2}-\d{2}/g, ' ')
    .replace(/\b\d{1,2}\.\d{1,2}\s*-\s*\d{1,2}\.\d{1,2}\b/g, ' ')
    .replace(/\b\d{2}\.20\d{2}\b/g, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .split(/(\s+)/).filter(w => !monthWord(w)).join('')
    .replace(/^[\s_\-–.]+|[\s_\-–.]+$/g, '')
    .replace(/\s{2,}/g, ' ');
}

export function deriveMeta(src: SourceConfig, folders: string[], fileName: string, modifiedAt: string): DocMeta {
  const out: { department: string | null; dataset: string | null } = { department: null, dataset: null };
  folders.forEach((seg, i) => {
    const level = src.levels[i];
    if (level === 'department') out.department = seg;
    if (level === 'dataset') out.dataset = stripDates(seg) || seg;
  });
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (!out.dataset) out.dataset = stripDates(stem) || stem;
  const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return {
    business: src.business, hotel: src.hotel, ...out,
    period: parsePeriod(folders, fileName, modifiedAt), pathSegments: folders, fileType: ext,
  };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodLabel(p: Period): string {
  const [y, m] = p.start.split('-');
  if (p.grain === 'month') return `${MON[Number(m) - 1]} ${y}`;
  if (p.grain === 'year') return y;
  if (p.grain === 'day') return p.start;
  if (p.grain === 'week') return `${p.start} to ${p.end}`;
  return '';
}

/** "Hotel › Department › Dataset › Aug 2024 › Heading", skipping empty parts. */
export function contextHeader(meta: DocMeta, heading: string | null): string {
  return [meta.hotel, meta.department, meta.dataset, periodLabel(meta.period), heading].filter(Boolean).join(' › ');
}
