import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { EDGES, NODES } from '../../../src/data.ts';
import type { MemNode, MemoryGraph } from '../../../src/types.ts';
import { DATA_DIR } from '../../paths.ts';

export type FactKind = 'semantic' | 'episodic' | 'procedural';
const NODE_TYPES: MemNode['type'][] = ['Organization', 'Location', 'System', 'Vendor', 'Person', 'Project'];
const RULES_NODE = 'rules';
/** Bump when the search index changes shape; open() rebuilds it from the tables. */
const SCHEMA = 2;

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(process.env.JARVIS_MEMORY_DB || join(DATA_DIR, 'memory.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE COLLATE NOCASE, type TEXT NOT NULL, x REAL, y REAL, source TEXT);
    CREATE TABLE IF NOT EXISTS edges (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, node_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, text TEXT NOT NULL, reason TEXT, created TEXT NOT NULL);
  `);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < SCHEMA) reindex(db);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
  if (!count) seed(db);
  return db;
}

/**
 * Search index v2: porter stemming (invoice/invoices, review/reviewing), node labels indexed with
 * their type, and rules left out (they are always included in full).
 */
function reindex(d: DatabaseSync) {
  d.exec(`
    DROP TABLE IF EXISTS mem_fts;
    CREATE VIRTUAL TABLE mem_fts USING fts5(ref UNINDEXED, text, tokenize = 'porter unicode61 remove_diacritics 2');
  `);
  for (const n of d.prepare('SELECT id, label, type FROM nodes').all() as { id: string; label: string; type: string }[]) ftsAdd(d, 'node:' + n.id, n.label + ' ' + n.type);
  for (const f of d.prepare('SELECT f.id, f.text, n.label FROM facts f JOIN nodes n ON n.id = f.node_id').all() as { id: number; text: string; label: string }[]) {
    ftsAdd(d, 'fact:' + f.id, f.label + ': ' + f.text);
  }
  d.exec(`PRAGMA user_version = ${SCHEMA}`);
}

function seed(d: DatabaseSync) {
  const now = new Date().toISOString();
  for (const n of NODES) {
    d.prepare('INSERT INTO nodes (id, label, type, x, y, source) VALUES (?, ?, ?, ?, ?, ?)').run(n.id, n.label, n.type, n.x, n.y, n.source);
    ftsAdd(d, 'node:' + n.id, n.label + ' ' + n.type);
    for (const f of n.facts) addFact(d, n.id, n.label, 'semantic', f, n.source, now);
  }
  for (const [a, b] of EDGES) d.prepare('INSERT OR IGNORE INTO edges (a, b) VALUES (?, ?)').run(a, b);
}

function ftsAdd(d: DatabaseSync, ref: string, text: string) {
  d.prepare('INSERT INTO mem_fts (ref, text) VALUES (?, ?)').run(ref, text);
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!\s]+$/, '').trim();

/** Adds a fact unless the node already has the same one; returns false for a duplicate. */
function addFact(d: DatabaseSync, nodeId: string, label: string, kind: FactKind, text: string, source: string, created: string) {
  const same = (d.prepare('SELECT id, text FROM facts WHERE node_id = ?').all(nodeId) as { id: number; text: string }[])
    .find(f => normText(f.text) === normText(text));
  if (same) {
    d.prepare('UPDATE facts SET created = ? WHERE id = ?').run(created, same.id); // seen again: counts as fresh
    return false;
  }
  const r = d.prepare('INSERT INTO facts (node_id, kind, text, source, created) VALUES (?, ?, ?, ?, ?)').run(nodeId, kind, text, source, created);
  ftsAdd(d, 'fact:' + r.lastInsertRowid, label + ': ' + text);
  return true;
}

/** Deterministic spot on the 0–100 graph canvas so new nodes don't jump around. */
function place(label: string) {
  let h = 2166136261;
  for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return { x: 8 + (Math.abs(h) % 84), y: 8 + (Math.abs(h >> 8) % 84) };
}

function findOrCreateNode(d: DatabaseSync, label: string, type: MemNode['type'], source: string): string {
  const row = d.prepare('SELECT id FROM nodes WHERE label = ?').get(label) as { id: string } | undefined;
  if (row) return row.id;
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { x, y } = place(label);
  d.prepare('INSERT INTO nodes (id, label, type, x, y, source) VALUES (?, ?, ?, ?, ?, ?)').run(id, label, type, x, y, source);
  ftsAdd(d, 'node:' + id, label + ' ' + type);
  return id;
}

/* ── search ─────────────────────────────────────────────────────────────────── */

/** Words that say nothing about what to look up. */
const STOP = new Set(('a an the and or but if then so to of in on at by for with from into about as is are was were be been being am do does did done '
  + 'have has had i me my mine we us our you your yours he him his she her they them their it its this that these those there here what which '
  + 'who whom whose when where why how can could should would will shall may might must not no yes please tell show give find get let know '
  + 'any some all each every more most other just also very really now today up out over again want need like jarvis hey ok okay').split(' '));

/** Content words of a query or text (no stop words, 2+ letters). */
export function keywords(q: string) {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).map(w => w.replace(/['’]s$/, '')).filter(w => w.length > 1 && !STOP.has(w)))];
}

/** FTS query that matches any content word by prefix, e.g. `"varian"* OR "flag"*`. */
function ftsQuery(q: string) {
  return keywords(q).slice(0, 12).map(w => `"${w.replace(/"/g, '')}"*`).join(' OR ');
}

interface Hit { id: number; kind: string; text: string; source: string; label: string; created: string; score: number }

const DAY = 86_400_000;
/** Newer facts rank higher: full weight this week, fading to half over ~3 months. */
const recency = (created: string) => {
  const age = (Date.now() - Date.parse(created)) / DAY;
  return Number.isFinite(age) ? 0.5 + 0.5 / (1 + Math.max(0, age - 7) / 90) : 0.5;
};

/** Ranked facts for a query: text matches, plus the latest facts about any person/system/vendor it names. */
function search(d: DatabaseSync, query: string, limit: number): Hit[] {
  const fq = ftsQuery(query);
  if (!fq) return [];
  const rows = d.prepare('SELECT ref, bm25(mem_fts) AS s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 60').all(fq) as { ref: string; s: number }[];
  const byId = new Map<number, Hit>();
  const factQ = d.prepare('SELECT f.id, f.kind, f.text, f.source, f.created, n.label FROM facts f JOIN nodes n ON n.id = f.node_id WHERE f.id = ?');
  const nodeFacts = d.prepare('SELECT f.id, f.kind, f.text, f.source, f.created, n.label FROM facts f JOIN nodes n ON n.id = f.node_id WHERE f.node_id = ? ORDER BY f.created DESC LIMIT 4');
  const add = (f: Omit<Hit, 'score'> | undefined, base: number) => {
    if (!f) return;
    const score = base * recency(f.created) * (f.kind === 'procedural' ? 1.1 : 1);
    const prev = byId.get(f.id);
    if (!prev || prev.score < score) byId.set(f.id, { ...f, score });
  };
  for (const { ref, s } of rows) {
    const [kind, id] = ref.split(':');
    const rel = -s; // bm25: lower is better
    if (kind === 'fact') add(factQ.get(Number(id)) as Omit<Hit, 'score'> | undefined, rel);
    // A named entity pulls in what we know about it, slightly below direct matches.
    else if (kind === 'node') for (const f of nodeFacts.all(id) as Omit<Hit, 'score'>[]) add(f, rel * 0.8);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const day = (iso: string) => (iso ? iso.slice(0, 10) : '');

/** Rules plus the facts that best match the query, formatted for a prompt. */
export function memoryQuery(query: string, limit = 12): string {
  const d = open();
  const rules = d.prepare('SELECT text, reason FROM rules ORDER BY id DESC LIMIT 20').all() as { text: string; reason: string | null }[];
  const lines: string[] = [];
  if (rules.length) lines.push('User rules and preferences (always follow):', ...rules.map(r => `- ${r.text}${r.reason ? ` (${r.reason})` : ''}`));
  const hits = search(d, query, limit);
  if (hits.length) lines.push('Matching memory (best first):', ...hits.map(h => `- [${h.kind}, ${day(h.created)}] ${h.label}: ${clip(h.text, 600)}`));
  return lines.length ? lines.join('\n') : 'No matching memory.';
}

/** Just the matching facts (no rules), for context attached to a chat message. Empty when nothing matches. */
export function memoryContext(query: string, limit = 8): string {
  const hits = search(open(), query, limit);
  return hits.map(h => `- [${h.kind}, ${day(h.created)}] ${h.label}: ${clip(h.text, 400)}`).join('\n');
}

/* ── writing ────────────────────────────────────────────────────────────────── */

export function memoryWrite(i: { entity: string; entity_type?: string; fact: string; kind?: FactKind; links?: string[]; source?: string }) {
  const d = open();
  const type = NODE_TYPES.includes(i.entity_type as MemNode['type']) ? (i.entity_type as MemNode['type']) : 'Project';
  const source = i.source || 'Learned during a task';
  const id = findOrCreateNode(d, i.entity, type, source);
  const label = (d.prepare('SELECT label FROM nodes WHERE id = ?').get(id) as { label: string }).label;
  const added = addFact(d, id, label, i.kind ?? 'semantic', i.fact, source, new Date().toISOString());
  for (const l of i.links ?? []) {
    const other = d.prepare('SELECT id FROM nodes WHERE label = ?').get(l) as { id: string } | undefined;
    if (other && other.id !== id) d.prepare('INSERT OR IGNORE INTO edges (a, b) VALUES (?, ?)').run(id, other.id);
  }
  return { id, added };
}

/** Share of content words two texts have in common (0–1). */
function overlap(a: string, b: string) {
  const x = new Set(keywords(a)), y = new Set(keywords(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

/**
 * Saves a rule. A rule that restates or updates an existing one (most of its words overlap)
 * replaces it, so corrections win instead of piling up. Returns the replaced rule, if any.
 */
export function memorySaveRule(text: string, reason?: string): string | null {
  const d = open();
  const now = new Date().toISOString();
  const old = (d.prepare('SELECT id, text FROM rules').all() as { id: number; text: string }[])
    .map(r => ({ ...r, o: overlap(r.text, text) })).filter(r => r.o >= 0.6).sort((a, b) => b.o - a.o)[0];
  if (old) {
    d.prepare('UPDATE rules SET text = ?, reason = ?, created = ? WHERE id = ?').run(text, reason ?? null, now, old.id);
    return old.text;
  }
  d.prepare('INSERT INTO rules (text, reason, created) VALUES (?, ?, ?)').run(text, reason ?? null, now);
  return null;
}

export function rulesText(): string {
  const rules = open().prepare('SELECT text FROM rules ORDER BY id DESC LIMIT 20').all() as { text: string }[];
  return rules.length ? rules.map(r => '- ' + r.text).join('\n') : '(none yet)';
}

/** Records a finished task in episodic memory so later questions ("what did you find about X?") can recall it. */
export function rememberTask(t: { title: string; app: string; summary: string; nextSteps?: string[] }) {
  if (!t.summary.trim() || /^(Stopped by you|Interrupted by a server restart|The task stopped because of an error|Stopped after \d+ steps)/.test(t.summary)) return;
  const d = open();
  const known = d.prepare('SELECT label FROM nodes WHERE label = ?').get(t.app) as { label: string } | undefined;
  const next = t.nextSteps?.length ? ` Next: ${t.nextSteps.join('; ')}` : '';
  memoryWrite({
    entity: known?.label ?? 'Jarvis task history', entity_type: known ? undefined : 'Project', kind: 'episodic',
    fact: clip(`${new Date().toISOString().slice(0, 10)} task "${t.title}": ${t.summary}${next}`, 1500), source: 'Task report',
  });
}

/** Graph for the Memory panel; saved rules appear as a "Your preferences" node. */
export function memoryGraph(): MemoryGraph {
  const d = open();
  const nodes = d.prepare('SELECT id, label, type, x, y, source FROM nodes').all() as Omit<MemNode, 'facts'>[];
  const facts = d.prepare('SELECT node_id, text FROM facts ORDER BY id').all() as { node_id: string; text: string }[];
  const byNode = new Map<string, string[]>();
  for (const f of facts) byNode.set(f.node_id, [...(byNode.get(f.node_id) ?? []), f.text]);
  const out: MemNode[] = nodes.map(n => ({ ...n, facts: byNode.get(n.id) ?? [] }));
  const edges = (d.prepare('SELECT a, b FROM edges').all() as { a: string; b: string }[]).map(e => [e.a, e.b] as [string, string]);
  const rules = d.prepare('SELECT text FROM rules ORDER BY id').all() as { text: string }[];
  if (rules.length) {
    out.push({ id: RULES_NODE, label: 'Your preferences', type: 'Person', x: 62, y: 50, facts: rules.map(r => r.text), source: 'Learned from your corrections' });
    if (out.some(n => n.id === 'n0')) edges.push([RULES_NODE, 'n0']);
  }
  return { nodes: out, edges };
}
