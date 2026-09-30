import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = dirname(SERVER_DIR);
export const DATA_DIR = process.env.JARVIS_DATA_DIR || join(APP_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });

/** Appends one JSON line per executed tool call to data/audit.jsonl. */
export function audit(entry: Record<string, unknown>) {
  try {
    appendFileSync(join(DATA_DIR, 'audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('audit write failed', e);
  }
}
