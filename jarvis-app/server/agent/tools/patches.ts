import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_DIR, DATA_DIR } from '../../paths.ts';

/*
 * On-disk record of Jarvis's self-modification patches, shared by the engine (selfmod.ts)
 * and the supervisor (server/supervisor.ts), which rolls a patch back if Jarvis can't start.
 * Only depends on paths.ts so the supervisor can load it without the rest of the app.
 */

export const PATCH_DIR = join(DATA_DIR, 'self-mod');
mkdirSync(PATCH_DIR, { recursive: true });
/** Set while a server patch is waiting for the restarted API to come up healthy. */
export const PENDING_FILE = join(PATCH_DIR, 'pending.json');
/** A crash or rollback the restarted API should start a repair task for. */
export const INCIDENT_FILE = join(PATCH_DIR, 'incident.json');

export interface Manifest { id: string; summary: string; task: string; time: string; files: { rel: string; existed: boolean }[]; reverted?: boolean }
export interface Incident { kind: 'crash' | 'rollback'; time: string; error: string; patch?: string; summary?: string }

export async function manifests(): Promise<Manifest[]> {
  if (!existsSync(PATCH_DIR)) return [];
  const out: Manifest[] = [];
  for (const d of await readdir(PATCH_DIR)) {
    try { out.push(JSON.parse(await readFile(join(PATCH_DIR, d, 'manifest.json'), 'utf8'))); } catch { /* not a patch */ }
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

export async function readManifest(id: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(PATCH_DIR, id, 'manifest.json'), 'utf8'));
}

/** Puts the files back as they were before the patch and marks it reverted. */
export async function restorePatch(id: string) {
  const m = await readManifest(id);
  for (const f of m.files) {
    const abs = join(APP_DIR, f.rel);
    if (f.existed) await writeFile(abs, await readFile(join(PATCH_DIR, id, 'files', f.rel)));
    else await rm(abs, { force: true });
  }
  m.reverted = true;
  await writeFile(join(PATCH_DIR, id, 'manifest.json'), JSON.stringify(m, null, 1));
  return m;
}

export const touchesServer = (files: { rel: string }[]) => files.some(f => f.rel.startsWith('server/'));
