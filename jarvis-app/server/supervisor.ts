import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR, DATA_DIR } from './paths.ts';
import { INCIDENT_FILE, PENDING_FILE, restorePatch, type Incident } from './agent/tools/patches.ts';

/*
 * Keeps the Jarvis API running (`npm run dev` / `npm start`):
 * - restarts it when it crashes (with backoff) and when files under server/ change,
 * - after a self-modification patch, waits for /api/health and rolls the patch back if the
 *   API doesn't come up, then
 * - leaves an incident for the restarted API, which starts a repair task for it.
 * Output is mirrored to data/server.log so repair tasks can read it.
 */

const PORT = Number(process.env.PORT) || 8787;
const LOG = join(DATA_DIR, 'server.log');
const HEALTH_TIMEOUT_MS = 45_000;
const IS_WIN = process.platform === 'win32';

let child: ChildProcess | null = null;
let startedAt = 0;
let expectedExit = false;
let backoff = 1000;
let tail: string[] = [];
let quietUntil = 0;
let stopping = false;

try { if (existsSync(LOG) && statSync(LOG).size > 2_000_000) rmSync(LOG); } catch { /* ignore */ }

function out(text: string) {
  process.stdout.write(text);
  try { appendFileSync(LOG, text); } catch { /* ignore */ }
  tail.push(...text.split(/\r?\n/).filter(Boolean));
  if (tail.length > 80) tail = tail.slice(-80);
}
const say = (msg: string) => out(`[supervisor ${new Date().toLocaleTimeString()}] ${msg}\n`);

function addIncident(i: Incident) {
  let list: Incident[] = [];
  try { if (existsSync(INCIDENT_FILE)) list = JSON.parse(readFileSync(INCIDENT_FILE, 'utf8')); } catch { /* start over */ }
  writeFileSync(INCIDENT_FILE, JSON.stringify([...list, i].slice(-5), null, 1));
}

const pending = (): { id: string } | null => {
  try { return existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')) : null; } catch { return null; }
};

function start() {
  tail = [];
  startedAt = Date.now();
  expectedExit = false;
  child = spawn(process.execPath, ['--import', 'tsx', '--env-file-if-exists=.env', 'server/index.ts'], {
    cwd: APP_DIR, env: { ...process.env, JARVIS_SUPERVISED: '1' }, windowsHide: true,
  });
  child.stdout?.on('data', d => out(String(d)));
  child.stderr?.on('data', d => out(String(d)));
  child.on('exit', onExit);
  const p = pending();
  if (p) checkHealth(p.id, child);
}

function kill(c: ChildProcess) {
  if (c.exitCode !== null) return;
  if (IS_WIN && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
  else c.kill('SIGTERM');
}

function restart(reason: string) {
  if (!child || stopping) return;
  say(`Restarting Jarvis: ${reason}`);
  expectedExit = true;
  kill(child);
}

/** Undoes the pending patch, records why, and lets the next start pick it up. */
async function rollback(id: string, error: string) {
  quietUntil = Date.now() + 3000; // the restore writes server files; don't double-restart
  try {
    const m = await restorePatch(id);
    say(`Rolled back patch ${id} (${m.summary}) because Jarvis failed to start.`);
    addIncident({ kind: 'rollback', time: new Date().toISOString(), error, patch: id, summary: m.summary });
  } catch (e) {
    say(`Rollback of ${id} failed: ${(e as Error).message}`);
  }
  rmSync(PENDING_FILE, { force: true });
}

async function checkHealth(id: string, c: ChildProcess) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline && c.exitCode === null && child === c) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) {
        rmSync(PENDING_FILE, { force: true });
        say(`Patch ${id} is live and Jarvis is healthy.`);
        return;
      }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (child !== c || c.exitCode !== null) return; // onExit handles a crash
  await rollback(id, `After patch ${id}, the API did not answer /api/health within ${HEALTH_TIMEOUT_MS / 1000}s.\n` + tail.slice(-40).join('\n'));
  restart('unhealthy after a patch');
}

async function onExit(code: number | null) {
  if (stopping) return;
  const ranFor = Date.now() - startedAt;
  if (expectedExit || code === 75) {
    backoff = 1000;
    start();
    return;
  }
  const error = `The API exited with code ${code} after ${Math.round(ranFor / 1000)}s.\n` + tail.slice(-40).join('\n');
  const p = pending();
  if (p) {
    await rollback(p.id, error);
    backoff = 1000;
  } else {
    addIncident({ kind: 'crash', time: new Date().toISOString(), error });
    backoff = ranFor > 60_000 ? 1000 : Math.min(backoff * 2, 30_000);
  }
  say(`Jarvis stopped unexpectedly (code ${code}). Restarting in ${backoff / 1000}s.`);
  setTimeout(start, backoff);
}

let timer: NodeJS.Timeout | null = null;
watch(join(APP_DIR, 'server'), { recursive: true }, (_e, file) => {
  if (!file || !/\.(ts|ps1)$/.test(file) || file.endsWith('.test.ts') || Date.now() < quietUntil) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => restart(`${file} changed`), 600);
});

const stop = () => {
  stopping = true;
  if (child) kill(child);
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

say('Starting Jarvis');
start();
