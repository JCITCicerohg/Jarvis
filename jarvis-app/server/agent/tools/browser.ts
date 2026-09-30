import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Download, type Page } from 'playwright-core';
import { S, clock } from '../../../src/data.ts';
import type { Approval } from '../../../src/types.ts';
import { DATA_DIR, audit } from '../../paths.ts';
import { store } from '../../state.ts';
import { DOWNLOADS } from './graph.ts';
import { clickRisk } from './risk.ts';
import { bool, parser, short, str, tool, type ToolCtx, type ToolSpec } from './spec.ts';

/* ── Engine: one persistent Edge profile so sign-ins survive restarts ─────────── */

const PROFILE = join(DATA_DIR, 'browser-profile');
let context: BrowserContext | null = null;
let current: Page | null = null;
/** Downloads started since the last action; awaited so their paths can be reported. */
let downloads: Promise<string>[] = [];

interface El { ref: string; role: string; name: string; value?: string }
/** Last snapshot's elements, used to re-find an element by role+name when its ref goes stale. */
let lastEls = new Map<string, El>();

export const browserChannel = () => process.env.JARVIS_BROWSER_CHANNEL || 'msedge';
export const browserOpen = () => !!context;

async function ctx(): Promise<BrowserContext> {
  if (context) return context;
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: browserChannel(),
    headless: process.env.JARVIS_BROWSER_HEADLESS === '1',
    viewport: { width: 1280, height: 860 },
    acceptDownloads: true,
  });
  context.on('close', () => { context = null; current = null; });
  context.on('page', p => { current = p; watch(p); });
  context.pages().forEach(watch);
  return context;
}

function watch(p: Page) {
  p.on('download', (d: Download) => {
    const out = join(DOWNLOADS, d.suggestedFilename());
    downloads.push(mkdir(DOWNLOADS, { recursive: true }).then(() => d.saveAs(out)).then(() => out, e => `(download failed: ${e.message})`));
  });
  p.on('close', () => { if (current === p) current = context?.pages().at(-1) ?? null; });
}

/** Browser-internal tabs (e.g. Edge's downloads hub after a download) aren't work pages. */
const internal = (p: Page) => /^(edge|chrome|about):/.test(p.url()) && p.url() !== 'about:blank';

async function page(): Promise<Page> {
  const c = await ctx();
  if (current && !current.isClosed() && !internal(current)) return current;
  current = c.pages().filter(p => !internal(p)).at(-1) ?? await c.newPage();
  return current;
}

export async function closeBrowser() { await context?.close(); }

/* ── Snapshot: tag interactive elements with refs the model can act on ────────── */

interface Snap { title: string; url: string; els: El[]; text: string }

/**
 * Runs in the page. Kept as a plain JS string: tsx/esbuild would otherwise inject
 * `__name()` helpers into a function passed to page.evaluate, and those don't exist there.
 */
const SNAPSHOT_JS = String.raw`(limit) => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=option],[role=combobox],[role=switch],[contenteditable=true]';
  document.querySelectorAll('[data-jarvis-ref]').forEach(e => e.removeAttribute('data-jarvis-ref'));
  const visible = e => {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clean = t => (t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const els = [];
  let n = 0;
  for (const e of Array.from(document.querySelectorAll(SEL))) {
    if (!visible(e) || els.length >= 200) continue;
    const labels = e.labels ? Array.from(e.labels).map(l => l.innerText).join(' ') : '';
    const name = clean(e.getAttribute('aria-label') || labels || e.innerText || e.placeholder || e.getAttribute('title') || e.getAttribute('alt') || (e.type === 'submit' ? e.value : '') || e.getAttribute('name'));
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role') || (tag === 'input' ? 'input[' + (e.type || 'text') + ']' : tag === 'a' ? 'link' : tag);
    const ref = 'e' + (++n);
    e.setAttribute('data-jarvis-ref', ref);
    const value = ['input', 'textarea', 'select'].includes(tag) && e.type !== 'password' ? clean(e.value) : '';
    els.push(value ? { ref, role, name, value } : { ref, role, name });
  }
  return { title: document.title, url: location.href, els, text: ((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n').slice(0, limit) };
}`;

async function snapshot(p: Page, textLimit: number): Promise<Snap> {
  const s = (await p.evaluate(`(${SNAPSHOT_JS})(${textLimit})`)) as Snap;
  lastEls = new Map(s.els.map(e => [e.ref, e]));
  return s;
}

const fmt = (s: Snap) =>
  `Page: ${s.title}\nURL: ${s.url}\n\nInteractive elements:\n${s.els.map(e => `[${e.ref}] ${e.role} "${e.name}"${e.value ? ` = "${e.value}"` : ''}`).join('\n') || '(none)'}\n\nVisible text:\n${s.text}`;

async function settle(p: Page) {
  try { await p.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch { /* keep going */ }
  await p.waitForTimeout(600);
}

/**
 * Finds the element for a ref. If the page re-rendered and the ref is gone, re-snapshots
 * and re-finds it by role+name (self-healing), logging a "fix" step when that happens.
 */
async function locate(p: Page, ref: string, c: ToolCtx) {
  const loc = p.locator(`[data-jarvis-ref="${ref}"]`);
  if (await loc.count()) return loc.first();
  const want = lastEls.get(ref);
  if (!want) throw new Error(`No element ${ref}. Call browser_snapshot to get fresh refs.`);
  const fresh = await snapshot(p, 0);
  const match = fresh.els.find(e => e.role === want.role && e.name === want.name)
    ?? fresh.els.find(e => e.name && e.name.toLowerCase() === want.name.toLowerCase())
    ?? fresh.els.find(e => want.name && e.name.toLowerCase().includes(want.name.toLowerCase()));
  if (!match) throw new Error(`Element ${ref} ("${want.name}") is no longer on the page. Call browser_snapshot.`);
  const note = `The page changed and "${want.name}" moved. Re-found it and kept going.`;
  store.step(c.taskId, S('fix', note, clock()));
  store.update(c.taskId, t => ({ ...t, fix: { text: note, time: clock() } }));
  store.toast({ kind: 'fix', task: c.taskId, title: 'Jarvis fixed itself', text: note });
  return p.locator(`[data-jarvis-ref="${match.ref}"]`).first();
}

/** Call before an action so the downloads it triggers are attributed to it. */
const beginAction = () => { downloads = []; };

async function afterAction(p: Page) {
  await settle(p);
  if (!downloads.length) await p.waitForTimeout(900); // give a click-triggered download a moment to start
  const files = await Promise.all(downloads);
  downloads = [];
  const cur = await page();
  return files.map(f => `Downloaded file: ${f}\n`).join('') + (files.length ? '\n' : '') + fmt(await snapshot(cur, 3000));
}

/* ── Tools ────────────────────────────────────────────────────────────────────── */

const labelOf = (ref: string) => lastEls.get(ref)?.name ?? '';

function clickGate(ref: string): Approval | null {
  const name = labelOf(ref);
  const risk = clickRisk(name);
  return risk ? { action: `Click "${short(name, 50)}" in the browser`, detail: `On ${current?.url() ?? 'the current page'}`, risk } : null;
}

export const BROWSER_TOOLS: ToolSpec<unknown>[] = [
  tool<{ url: string }>({
    def: {
      name: 'browser_open',
      description: 'Browser_Engine: open a URL in Jarvis\'s own Edge window (persistent profile, so sign-ins are remembered) and return a snapshot with element refs.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    parse: parser(o => {
      const url = str(o, 'url')!;
      return { url: /^[a-z]+:\/\//i.test(url) ? url : 'https://' + url };
    }),
    step: i => ({ kind: 'browse', text: 'Opened ' + short(i.url, 100) }),
    run: async i => {
      const p = await page();
      await p.goto(i.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(p);
      return fmt(await snapshot(p, 6000));
    },
  }),
  tool<Record<string, never>>({
    def: { name: 'browser_snapshot', description: 'Browser_Engine: re-read the current page: title, URL, interactive elements with refs, and visible text.', input_schema: { type: 'object', properties: {} } },
    parse: () => ({}),
    step: () => ({ kind: 'browse', text: 'Read the page' }),
    run: async () => fmt(await snapshot(await page(), 8000)),
  }),
  tool<{ ref: string }>({
    def: {
      name: 'browser_click',
      description: 'Browser_Engine: click an element by ref from the latest snapshot. Clicks labelled send/pay/delete ask the user first. Returns the updated page, and the local path of any download it triggered.',
      input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    },
    parse: parser(o => ({ ref: str(o, 'ref')! })),
    step: i => ({ kind: 'browse', text: `Clicked "${short(labelOf(i.ref) || i.ref, 70)}"` }),
    gate: i => clickGate(i.ref),
    run: async (i, c) => {
      const p = await page();
      beginAction();
      await (await locate(p, i.ref, c)).click({ timeout: 10_000 });
      audit({ task: c.taskId, tool: 'browser_click', ref: i.ref, label: labelOf(i.ref), url: p.url() });
      return afterAction(p);
    },
  }),
  tool<{ ref: string; text: string; submit: boolean }>({
    def: {
      name: 'browser_type',
      description: 'Browser_Engine: fill a text field by ref (replaces its content). submit=true presses Enter afterwards.',
      input_schema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] },
    },
    parse: parser(o => {
      if (typeof o.text !== 'string') throw new Error('"text" must be a string');
      return { ref: str(o, 'ref')!, text: o.text, submit: bool(o, 'submit') };
    }),
    step: i => ({ kind: 'browse', text: `Typed into "${short(labelOf(i.ref) || i.ref, 50)}"` }),
    run: async (i, c) => {
      const p = await page();
      const el = await locate(p, i.ref, c);
      beginAction();
      await el.fill(i.text, { timeout: 10_000 });
      if (i.submit) await el.press('Enter');
      return afterAction(p);
    },
  }),
  tool<{ ref: string; value: string }>({
    def: {
      name: 'browser_select',
      description: 'Browser_Engine: choose an option in a <select> by its visible label or value.',
      input_schema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] },
    },
    parse: parser(o => ({ ref: str(o, 'ref')!, value: str(o, 'value')! })),
    step: i => ({ kind: 'browse', text: `Selected "${short(i.value, 50)}"` }),
    run: async (i, c) => {
      const p = await page();
      const el = await locate(p, i.ref, c);
      beginAction();
      try { await el.selectOption({ label: i.value }, { timeout: 5000 }); } catch { await el.selectOption(i.value, { timeout: 5000 }); }
      return afterAction(p);
    },
  }),
  tool<{ selector?: string; tables: boolean }>({
    def: {
      name: 'browser_extract',
      description: 'Browser_Engine: extract text from the page or a CSS selector. tables=true returns every HTML table as tab-separated rows (good for reports).',
      input_schema: { type: 'object', properties: { selector: { type: 'string' }, tables: { type: 'boolean' } } },
    },
    parse: parser(o => ({ selector: str(o, 'selector', false), tables: bool(o, 'tables') })),
    step: i => ({ kind: 'browse', text: i.tables ? 'Extracted the tables on the page' : 'Extracted text from the page' }),
    run: async i => {
      const p = await page();
      if (i.tables) {
        const t = await p.evaluate(() => Array.from(document.querySelectorAll('table')).map((tb, k) =>
          `Table ${k + 1}:\n` + Array.from(tb.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('th,td')).map(c => (c as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n')).join('\n\n'));
        return short(t || 'No tables on the page.', 30_000);
      }
      const text = i.selector
        ? (await p.locator(i.selector).allInnerTexts()).join('\n---\n')
        : await p.evaluate(() => document.body?.innerText ?? '');
      return short(text || '(empty)', 30_000);
    },
  }),
  tool<Record<string, never>>({
    def: { name: 'browser_screenshot', description: 'Browser_Engine: take a screenshot of the current page to see its layout (charts, visual state, captchas).', input_schema: { type: 'object', properties: {} } },
    parse: () => ({}),
    step: () => ({ kind: 'browse', text: 'Looked at the page' }),
    run: async () => {
      const p = await page();
      const buf = await p.screenshot({ type: 'jpeg', quality: 70 });
      return { text: `Screenshot of ${p.url()}`, image: { data: buf.toString('base64'), mediaType: 'image/jpeg' } };
    },
  }),
  tool<{ direction: 'back' | 'forward' | 'reload' }>({
    def: {
      name: 'browser_navigate',
      description: 'Browser_Engine: go back, forward or reload.',
      input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['direction'] },
    },
    parse: parser(o => {
      const d = str(o, 'direction')!;
      if (d !== 'back' && d !== 'forward' && d !== 'reload') throw new Error('direction must be back, forward or reload');
      return { direction: d };
    }),
    step: i => ({ kind: 'browse', text: { back: 'Went back', forward: 'Went forward', reload: 'Reloaded the page' }[i.direction] }),
    run: async i => {
      const p = await page();
      beginAction();
      if (i.direction === 'back') await p.goBack(); else if (i.direction === 'forward') await p.goForward(); else await p.reload();
      return afterAction(p);
    },
  }),
];
