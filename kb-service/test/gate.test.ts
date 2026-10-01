import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { loadEvalRows, scoreEval } from '../src/eval/score.ts';
import { errorCount, evaluate, gateVerdict } from '../src/gen/gate.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db;
const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-gate-')));
const qd = () => ({ db, gen: 1, blob, embedder: new FakeEmbedder(), planner: { plan: async (q: string) => fallbackPlan(q) } });

beforeAll(async () => {
  db = await freshDb();
  await ingestFile(qd(), SRC, { sourceId: 'hilton-pbi', driveItemId: 'P', parentId: null, name: 'Pool report.txt', folders: ['Engineering'], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('The pool pump was replaced in August.'));
  await ingestFile(qd(), SRC, { sourceId: 'hilton-pbi', driveItemId: 'X', parentId: null, name: 'broken.xlsx', folders: [], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('not a zip'));
});
afterAll(async () => { await db.end(); });

describe('eval + gate', () => {
  it('scores an empty set as zero, not NaN', () => {
    expect(scoreEval([], [])).toEqual({ questions: 0, hit_at_5: 0, mrr: 0, numeric_accuracy: null });
  });

  it('loads JSONL questions, skipping blank lines', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kb-q-')), 'q.jsonl');
    writeFileSync(p, '{"question":"a","expected_files":["x"]}\n\n{"question":"b","expected_files":["y"]}\n');
    expect(loadEvalRows(p).map(r => r.question)).toEqual(['a', 'b']);
  });

  it('evaluates a generation and logs queries as the eval user', async () => {
    const s = await evaluate(qd(), [{ question: 'pool pump replaced', expected_files: ['Pool report.txt'] }]);
    expect(s).toEqual({ hit5: 1, mrr: 1 });
    expect((await db.query(`SELECT user_name FROM kb_meta.query_log ORDER BY id DESC LIMIT 1`)).rows[0].user_name).toBe('eval');
    expect(await errorCount(db, 1)).toBe(1);
  });

  it('passes only when every gate condition holds, and says why not', () => {
    const ok = { candidate: { build_done: 10, build_total: 10, errors: 1, hit5: 0.9 }, live: { errors: 1, hit5: 0.88 }, questions: 6 };
    expect(gateVerdict(ok)).toEqual({ ready: true, reasons: [] });
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, build_done: 4 } }).reasons).toEqual(['Build is not finished (4 of 10 files).']);
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, errors: 3 } }).reasons).toEqual(['More files failed than in the live generation (3 vs 1).']);
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, hit5: 0.8 } }).reasons).toEqual(['Eval hit@5 0.80 is below 0.85.', 'Eval hit@5 0.80 is below the live generation (0.88).']);
    expect(gateVerdict({ ...ok, questions: 0 }).reasons).toEqual(['No eval questions configured (eval/questions.jsonl).']);
  });
});
