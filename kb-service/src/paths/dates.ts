export type Grain = 'day' | 'week' | 'month' | 'year';
export interface Period { start: string; end: string; grain: Grain | null }

const SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const month = (y: number, m: number): Period => ({ start: iso(y, m, 1), end: iso(y, m, lastDay(y, m)), grain: 'month' });
const year = (y: number): Period => ({ start: `${y}-01-01`, end: `${y}-12-31`, grain: 'year' });
const validMD = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** 1-12 for a whole month word ("Aug", "August", "Sept"), else 0. */
export function monthWord(w: string): number {
  const l = w.toLowerCase().replace(/\.$/, '');
  if (l === 'sept') return 9;
  const i = FULL.indexOf(l);
  if (i >= 0) return i + 1;
  const j = SHORT.indexOf(l);
  return j >= 0 ? j + 1 : 0;
}

const words = (s: string) => s.split(/[^A-Za-z]+/).filter(Boolean);
const yearOf = (s: string) => { const m = /(?:^|[^\d])(20\d{2})(?!\d)/.exec(s); return m ? Number(m[1]) : null; };

function day(s: string): Period | null {
  const m = /(20\d{2})-(\d{2})-(\d{2})/.exec(s);
  if (!m || !validMD(Number(m[2]), Number(m[3]))) return null;
  const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
  return { start: d, end: d, grain: 'day' };
}

function weekRange(s: string, y: number): Period | null {
  const m = /(?:^|[^\d.])(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})(?![\d.])/.exec(s);
  if (!m) return null;
  const [m1, d1, m2, d2] = m.slice(1).map(Number);
  if (!validMD(m1, d1) || !validMD(m2, d2)) return null;
  return { start: iso(y, m1, d1), end: iso(m2 < m1 ? y + 1 : y, m2, d2), grain: 'week' };
}

function monthNumeric(s: string): Period | null {
  const m = /(?:^|[^\d.])(\d{2})\.(20\d{2})(?!\d)/.exec(s);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? month(Number(m[2]), Number(m[1])) : null;
}

function monthName(s: string, contextYear: number | null): Period | null {
  const m = words(s).map(monthWord).find(Boolean);
  if (!m) return null;
  const y = yearOf(s) ?? contextYear;
  return y ? month(y, m) : null;
}

function monthFolder(s: string, contextYear: number | null): Period | null {
  const m = /^\s*(\d{1,2})\s*$/.exec(s);
  return m && contextYear && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? month(contextYear, Number(m[1])) : null;
}

/**
 * Reads a period from folder and file names, most specific first: the file name
 * (day, week range, MM.YYYY, "Month YYYY"), then folders deepest first ("07 - July",
 * "8 Aug", "08" under a year folder), then any year. Falls back to the modified date
 * with grain null, so a file never fails ingestion because of its name.
 */
export function parsePeriod(folders: string[], fileName: string, modifiedAt: string): Period {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const ctxYear = yearOf(stem) ?? [...folders].reverse().map(yearOf).find(y => y !== null) ?? null;
  const fallbackYear = ctxYear ?? Number(modifiedAt.slice(0, 4));

  const fromFile = day(stem) ?? weekRange(stem, fallbackYear) ?? monthNumeric(stem) ?? monthName(stem, ctxYear);
  if (fromFile) return fromFile;
  for (const f of [...folders].reverse()) {
    const p = monthNumeric(f) ?? monthName(f, ctxYear) ?? monthFolder(f, ctxYear);
    if (p) return p;
  }
  if (ctxYear) return year(ctxYear);
  const d = modifiedAt.slice(0, 10);
  return { start: d, end: d, grain: null };
}
