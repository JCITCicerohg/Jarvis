import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import { upsertSources, type SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { GraphError, relSegments, syncSource, type DeltaPage, type GraphItem, type GraphLike } from '../src/sync/runner.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'DRV', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
const P = (p: string) => ({ id: 'x', path: `/drives/DRV/root:${p}` });

const folder = (id: string, name: string, parent: string): GraphItem => ({ id, name, folder: {}, parentReference: P(parent) });
const file = (id: string, name: string, parent: string, ctag = 'c1'): GraphItem => ({
  id, name, file: { mimeType: 'text/plain' }, parentReference: P(parent), size: 10, cTag: ctag, eTag: 'e', webUrl: `https://sp/${id}`, lastModifiedDateTime: '2026-09-01T00:00:00Z',
});

class FakeGraph implements GraphLike {
  pages = new Map<string, DeltaPage | 'gone'>();
  downloads: string[] = [];
  contents = new Map<string, string>();
  async delta(url: string) {
    const p = this.pages.get(url);
    if (p === 'gone') throw new GraphError(410, 'resync required');
    if (!p) throw new Error('unexpected url ' + url);
    return p;
  }
  async download(_drive: string, item: GraphItem) { this.downloads.push(item.id); return Buffer.from(this.contents.get(item.id) ?? 'hello'); }
}

let db: Db;
const START = 'https://graph.microsoft.com/v1.0/drives/DRV/root/delta';
const count = async () => Number((await db.query('SELECT count(*) n FROM kb_g1.documents')).rows[0].n);

beforeAll(async () => { db = await freshDb(); await upsertSources(db, [SRC]); });
beforeEach(async () => { await db.query('TRUNCATE kb_g1.documents, kb_g1.folders RESTART IDENTITY CASCADE; DELETE FROM kb_meta.sync_state; DROP SCHEMA IF EXISTS kb_g2 CASCADE'); });
afterAll(async () => { await db.end(); });

const deps = (graph: GraphLike) => ({ db, gen: 1, blob: new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-sync-'))), embedder: new FakeEmbedder(), graph });

describe('relSegments', () => {
  it('decodes paths and scopes to the source root', () => {
    expect(relSegments(SRC, file('a', "notes.txt", '/Hilton%20Palm%20Beach%20PBI/F%26B/Micros%20(Uno\'s)'))).toEqual(['F&B', "Micros (Uno's)", 'notes.txt']);
    expect(relSegments(SRC, folder('r', 'Hilton Palm Beach PBI', ''))).toEqual([]);
    expect(relSegments(SRC, file('o', 'x.txt', '/Other Hotel'))).toBeNull();
    expect(relSegments(SRC, file('o', 'x.txt', '/Hilton Palm Beach PBI Annex'))).toBeNull();
  });
});

describe('syncSource', () => {
  it('backfills, then applies edits and deletes from the saved deltaLink', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [folder('F1', 'Guest Scores', '/Hilton Palm Beach PBI'), file('A', 'a.txt', '/Hilton Palm Beach PBI/Guest Scores'), file('OUT', 'o.txt', '/Other')], '@odata.nextLink': 'page2' });
    g.pages.set('page2', { value: [file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'delta1' });
    const s1 = await syncSource(deps(g), SRC);
    expect(s1).toMatchObject({ indexed: 2, folders: 1, resync: true });
    expect(await count()).toBe(2);
    const st = (await db.query('SELECT delta_link, items_last_run, last_error FROM kb_meta.sync_state')).rows[0];
    expect(st).toEqual({ delta_link: 'delta1', items_last_run: 4, last_error: null });

    g.pages.set('delta1', { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI/Guest Scores', 'c1'), file('B', 'b.txt', '/Hilton Palm Beach PBI', 'c2'), { id: 'A', deleted: {} }], '@odata.deltaLink': 'delta2' });
    g.contents.set('B', 'changed');
    g.downloads = [];
    const s2 = await syncSource(deps(g), SRC);
    expect(g.downloads).toEqual(['B']);
    expect(s2).toMatchObject({ indexed: 1, unchanged: 1, deleted: 1, resync: false });
    expect(await count()).toBe(1);
  });

  it('on 410 does a full resync and removes documents that no longer exist', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI'), file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd1' });
    await syncSource(deps(g), SRC);
    g.pages.set('d1', 'gone');
    g.pages.set(START, { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd2' });
    const s = await syncSource(deps(g), SRC);
    expect(s).toMatchObject({ resync: true, deleted: 1 });
    expect((await db.query('SELECT drive_item_id FROM kb_g1.documents')).rows).toEqual([{ drive_item_id: 'A' }]);
  });

  it('keeps the old deltaLink when Graph fails mid-run, and running again changes nothing twice', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI')], '@odata.nextLink': 'broken' });
    await expect(syncSource(deps(g), SRC)).rejects.toThrow();
    const st = (await db.query('SELECT delta_link, last_error FROM kb_meta.sync_state')).rows[0];
    expect(st.delta_link).toBeNull();
    expect(st.last_error).toContain('unexpected url');
    g.pages.set('broken', { value: [], '@odata.deltaLink': 'ok' });
    await syncSource(deps(g), SRC);
    expect(await count()).toBe(1);
  });

  it('skips files over the size limit', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [{ ...file('BIG', 'huge.pdf', '/Hilton Palm Beach PBI'), size: 200 * 1024 * 1024 }], '@odata.deltaLink': 'x' });
    expect((await syncSource(deps(g), SRC)).skipped).toBe(1);
    expect(g.downloads).toEqual([]);
  });

  it('applies every change to extra generations too', async () => {
    await db.query(`DROP SCHEMA IF EXISTS kb_g2 CASCADE`);
    const { generationDdl } = await import('../src/db/migrate.ts');
    await db.query(generationDdl(2, 384));
    const g = new FakeGraph();
    g.pages.set(START, { value: [folder('F1', 'Guest Scores', '/Hilton Palm Beach PBI'), file('A', 'a.txt', '/Hilton Palm Beach PBI/Guest Scores'), file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd1' });
    const base = deps(g);
    const extra = { ...base, gen: 2 };
    await syncSource({ ...base, extra: [extra] }, SRC);
    const ids = async (s: string) => (await db.query(`SELECT drive_item_id FROM ${s}.documents ORDER BY 1`)).rows.map(r => r.drive_item_id);
    expect(await ids('kb_g2')).toEqual(['A', 'B']);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.folders')).rows[0].n).toBe(1);
    g.pages.set('d1', { value: [{ id: 'A', deleted: {} }], '@odata.deltaLink': 'd2' });
    await syncSource({ ...base, extra: [extra] }, SRC);
    expect(await ids('kb_g1')).toEqual(['B']);
    expect(await ids('kb_g2')).toEqual(['B']);
  });

  it('throttles a backfill (slow lane) but not a small delta (fast lane)', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI'), file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd1' });
    let paced = 0;
    const pacer = { beforeFile: async () => { paced++; } };
    await syncSource({ ...deps(g), pacer }, SRC);
    expect(paced).toBe(2);
    g.pages.set('d1', { value: [file('C', 'c.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd2' });
    paced = 0;
    await syncSource({ ...deps(g), pacer }, SRC);
    expect(paced).toBe(0);
  });
});
