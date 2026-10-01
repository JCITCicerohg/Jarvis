import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Db } from './db/pool.ts';

export type Level = 'department' | 'dataset';
export interface SourceConfig {
  id: string; name: string; business: string; hotel: string | null;
  drive_id: string; root_path: string; levels: Level[]; enabled: boolean;
}

const LEVELS: Level[] = ['department', 'dataset'];

export function loadSources(path: string): SourceConfig[] {
  const doc = YAML.parse(readFileSync(path, 'utf8')) as { sources?: Record<string, unknown>[] };
  if (!Array.isArray(doc?.sources)) throw new Error(`${path}: expected a "sources" list`);
  return doc.sources.map((s, i) => {
    const need = (k: string) => {
      const v = s[k];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${path}: sources[${i}].${k} must be a non-empty string`);
      return v.trim();
    };
    const levels = s.levels ?? LEVELS;
    if (!Array.isArray(levels) || !levels.every(l => LEVELS.includes(l as Level))) {
      throw new Error(`${path}: sources[${i}].levels may only contain ${LEVELS.join(', ')}`);
    }
    return {
      id: need('id'), name: need('name'), business: need('business'),
      hotel: typeof s.hotel === 'string' && s.hotel.trim() ? s.hotel.trim() : null,
      drive_id: need('drive_id'), root_path: need('root_path').replace(/^\/+|\/+$/g, ''),
      levels: levels as Level[], enabled: s.enabled !== false,
    };
  });
}

export async function upsertSources(db: Db, sources: SourceConfig[]): Promise<void> {
  for (const s of sources) {
    await db.query(
      `INSERT INTO kb_meta.sources (id, name, business, hotel, drive_id, root_path, levels, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name=$2, business=$3, hotel=$4, drive_id=$5, root_path=$6, levels=$7, enabled=$8`,
      [s.id, s.name, s.business, s.hotel, s.drive_id, s.root_path, s.levels, s.enabled],
    );
  }
}

export type LlmProvider = 'anthropic' | 'openai' | 'azure';
export interface Env {
  databaseUrl: string; port: number; blobDir: string; sourcesFile: string;
  apiKeys: Map<string, string>; adminKeys: Map<string, string>; openaiKey: string; syncMinutes: number;
  llm: { provider: LlmProvider; model: string };
  embedProvider: 'local' | 'openai' | 'azure';
  azure: { endpoint: string; key: string; apiVersion: string; embedDeployment: string };
  ms: { tenantId: string; clientId: string; clientSecret: string } | null;
  configVersion: string | null; evalFile: string;
}

const LLM_DEFAULTS: Record<LlmProvider, string> = { anthropic: 'claude-haiku-4-5', openai: 'gpt-5-mini', azure: '' };

/** KB_API_KEYS="owner:abc,exec:def" → Map(key → name). */
export function parseKeys(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of s.split(',').map(x => x.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1)) m.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return m;
}

export function loadEnv(): Env {
  const e = process.env;
  const ms = e.KB_MS_TENANT_ID && e.KB_MS_CLIENT_ID && e.KB_MS_CLIENT_SECRET
    ? { tenantId: e.KB_MS_TENANT_ID, clientId: e.KB_MS_CLIENT_ID, clientSecret: e.KB_MS_CLIENT_SECRET } : null;
  const provider = (e.KB_LLM_PROVIDER ?? 'anthropic') as LlmProvider;
  if (!(provider in LLM_DEFAULTS)) throw new Error(`KB_LLM_PROVIDER must be anthropic, openai or azure (got "${provider}")`);
  const embedProvider = (e.KB_EMBED_PROVIDER || 'local') as Env['embedProvider'];
  if (!['local', 'openai', 'azure'].includes(embedProvider)) throw new Error(`KB_EMBED_PROVIDER must be local, openai or azure (got "${embedProvider}")`);
  return {
    llm: { provider, model: e.KB_LLM_MODEL || LLM_DEFAULTS[provider] },
    embedProvider,
    azure: {
      endpoint: (e.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/+$/, ''), key: e.AZURE_OPENAI_API_KEY ?? '',
      apiVersion: e.AZURE_OPENAI_API_VERSION || '2024-10-21', embedDeployment: e.AZURE_OPENAI_EMBED_DEPLOYMENT ?? '',
    },
    databaseUrl: e.DATABASE_URL ?? 'postgres://kb:kb@localhost:5433/kb',
    port: Number(e.PORT ?? 8790),
    blobDir: e.BLOB_DIR ?? 'data/blobs',
    sourcesFile: e.SOURCES_FILE ?? 'config/sources.yaml',
    apiKeys: parseKeys(e.KB_API_KEYS ?? ''),
    adminKeys: parseKeys(e.KB_ADMIN_KEYS ?? ''),
    openaiKey: e.OPENAI_API_KEY ?? '',
    syncMinutes: Number(e.SYNC_MINUTES ?? 5),
    configVersion: e.KB_CONFIG_VERSION || null,
    evalFile: e.EVAL_FILE ?? 'eval/questions.jsonl',
    ms,
  };
}
