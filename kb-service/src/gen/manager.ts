import type { SourceConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { EvalRow } from '../eval/score.ts';
import type { IngestDeps } from '../ingest/pipeline.ts';
import type { QueryDeps } from '../query/executor.ts';
import type { Planner } from '../query/planner.ts';
import type { BlobStore } from '../store/blob.ts';
import type { Pacer } from '../sync/pacer.ts';
import { buildGeneration } from './build.ts';
import { errorCount, evaluate as runEval, gateVerdict } from './gate.ts';
import {
  GenError, activeGeneration, createGeneration, cutover, discardGeneration, dropExpired, getGeneration,
  listGenerations, rollback, setGeneration, writableGenerations, type Generation,
} from './registry.ts';

export interface ManagerDeps {
  db: Db; blob: BlobStore; planner: Planner; sources: SourceConfig[];
  embedderFor(model: string): Embedder; nextEmbedder(): Embedder;
  evalRows(): EvalRow[]; configVersion: string | null; pacer?: Pacer;
}

export class GenerationManager {
  private building: Promise<void> | null = null;
  constructor(private d: ManagerDeps) {}

  private ingestDeps(g: Generation): IngestDeps {
    return { db: this.d.db, gen: g.id, blob: this.d.blob, embedder: this.d.embedderFor(g.embedding_model) };
  }

  private qd(g: Generation): QueryDeps {
    return { ...this.ingestDeps(g), planner: this.d.planner };
  }

  async queryDeps(): Promise<QueryDeps> { return this.qd(await activeGeneration(this.d.db)); }

  async targets(): Promise<{ primary: IngestDeps; extra: IngestDeps[] }> {
    const [primary, ...rest] = await writableGenerations(this.d.db);
    return { primary: this.ingestDeps(primary), extra: rest.map(g => this.ingestDeps(g)) };
  }

  list(): Promise<Generation[]> { return listGenerations(this.d.db); }

  async startBuild(): Promise<number> {
    if (this.building) throw new GenError('A build is already running.');
    const e = this.d.nextEmbedder();
    const id = await createGeneration(this.d.db, e.model, e.dim, this.d.configVersion);
    this.building = this.runBuild(id)
      .catch(err => setGeneration(this.d.db, id, { status: 'failed', note: String((err as Error).message).slice(0, 500) }))
      .finally(() => { this.building = null; });
    return id;
  }

  async waitForBuild(): Promise<void> { await this.building; }

  private async runBuild(id: number): Promise<void> {
    const live = await activeGeneration(this.d.db);
    const target = (await getGeneration(this.d.db, id))!;
    const r = await buildGeneration({
      db: this.d.db, sources: this.d.sources, from: this.ingestDeps(live), to: this.ingestDeps(target), pacer: this.d.pacer,
      onProgress: (done, total) => setGeneration(this.d.db, id, { build_done: done, build_total: total }),
    });
    await setGeneration(this.d.db, id, { status: 'catching_up', build_done: r.done, build_total: r.total });
    await this.evaluate(id);
  }

  /** Runs the eval on the candidate and the live generation and applies the gate. */
  async evaluate(id: number): Promise<{ ready: boolean; reasons: string[] }> {
    const cand = await getGeneration(this.d.db, id);
    if (!cand || !['catching_up', 'ready'].includes(cand.status)) throw new GenError(`Generation ${id} is not waiting for evaluation.`);
    const live = await activeGeneration(this.d.db);
    const rows = this.d.evalRows();
    const [c, l] = rows.length ? [await runEval(this.qd(cand), rows), await runEval(this.qd(live), rows)] : [{ hit5: 0, mrr: 0 }, { hit5: 0, mrr: 0 }];
    const verdict = gateVerdict({
      candidate: { build_done: cand.build_done, build_total: cand.build_total, errors: await errorCount(this.d.db, id), hit5: c.hit5 },
      live: { errors: await errorCount(this.d.db, live.id), hit5: l.hit5 },
      questions: rows.length,
    });
    await setGeneration(this.d.db, id, {
      eval_hit5: c.hit5, eval_mrr: c.mrr, status: verdict.ready ? 'ready' : 'catching_up', note: verdict.reasons.join(' ') || null,
    });
    return verdict;
  }

  cutover(id: number) { return cutover(this.d.db, id); }
  rollback() { return rollback(this.d.db); }
  discard(id: number) { return discardGeneration(this.d.db, id); }
  dropExpired() { return dropExpired(this.d.db); }
}
