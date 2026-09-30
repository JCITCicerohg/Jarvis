import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { APP_DIR, DATA_DIR, audit } from '../../paths.ts';
import { store } from '../../state.ts';
import { PATCH_DIR as ROOT, PENDING_FILE, manifests, readManifest, restorePatch, touchesServer, type Manifest } from './patches.ts';
import { parser, short, str, tool, type ToolSpec } from './spec.ts';

/*
 * Self_Modification_Engine (Phase 3) — production and a workspace.
 *
 * Production is the running app in APP_DIR. Jarvis never edits it directly: it edits a full copy
 * in .workspace/, typechecks every edit there, and runs the workspace as a separate test instance
 * (API :8788, web :5174, its own data folder) to try the change. The live app keeps running
 * untouched. When the change is ready, Jarvis asks for a release; the user approves the diff,
 * and the release is applied only when the user is idle (no running tasks, no recent activity)
 * or when they press "Apply now", so Jarvis never restarts in the middle of a session.
 * Applied releases are backed up in data/self-mod/<id>/ for revert, and the supervisor rolls a
 * release back if the API doesn't come up after it.
 */

export const WORKSPACE = join(APP_DIR, '.workspace');
const META = join(WORKSPACE, '.workspace.json');
const RELEASE_FILE = join(ROOT, 'release.json');
const TEST_DATA = join(DATA_DIR, 'test-instance');
const TEST_API_PORT = 8788;
const TEST_WEB_PORT = 5174;
const TEST_TTL_MS = 30 * 60_000;
/** What the workspace copies from production. */
const SYNCED = ['src', 'server', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts'];
/** Where Jarvis may edit itself. */
const EDITABLE = ['src/', 'server/', 'index.html'];
/** The approval gates, this engine and its safety net (supervisor, rollback, repair limits) stay under the user's hand. */
const PROTECTED = [
  'server/agent/tools/risk.ts', 'server/agent/tools/risk.test.ts', 'server/agent/tools/selfmod.ts', 'server/agent/tools/patches.ts',
  'server/supervisor.ts', 'server/agent/autofix.ts',
];
export const IS_TEST_INSTANCE = !!process.env.JARVIS_TEST_INSTANCE;

interface Edit { path: string; old: string; new: string }
interface Input { summary: string; edits: Edit[] }
interface Meta { synced: string; base: Record<string, string>; tested?: string }
interface Release { summary: string; files: string[]; hash: string; time: string; task: string; diff: string }
/** A workspace file that differs from production. `prod` is null for a new file. */
interface Change { rel: string; ws: string; prod: string | null }

let busy = false;
const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (busy) throw new Error('another self-modification step is in progress. Wait for it to finish.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
};

const norm = (s: string) => s.replace(/\r\n/g, '\n');
const hash = (s: string) => createHash('sha1').update(norm(s)).digest('hex');
const toRel = (p: string) => {
  const abs = isAbsolute(p) ? p : resolve(WORKSPACE, p);
  // Accept paths into either tree; both map to the same relative path.
  const fromWs = relative(WORKSPACE, abs), fromApp = relative(APP_DIR, abs);
  return (fromWs.startsWith('..') ? fromApp : fromWs).split(sep).join('/');
};

function checkPath(p: string) {
  const rel = toRel(p);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${p} is outside Jarvis's workspace (${WORKSPACE})`);
  if (!EDITABLE.some(e => (e.endsWith('/') ? rel.startsWith(e) : rel === e))) throw new Error(`${rel}: Jarvis can only edit ${EDITABLE.join(', ')}`);
  if (PROTECTED.includes(rel)) throw new Error(`${rel} is protected (approval gates, the self-modification engine and its safety net). Tell the user to edit it by hand.`);
  return rel;
}

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(dir, r));
    else out.push(r);
  }
  return out;
}

/** Every synced file in a tree, as relative paths. */
async function files(root: string) {
  const out: string[] = [];
  for (const x of SYNCED) {
    const abs = join(root, x);
    if (!existsSync(abs)) continue;
    if ((await stat(abs)).isDirectory()) out.push(...(await walk(root, x)));
    else out.push(x);
  }
  return out;
}

const readMeta = async (): Promise<Meta> => JSON.parse(await readFile(META, 'utf8'));
const writeMeta = (m: Meta) => writeFile(META, JSON.stringify(m, null, 1));

/** Replaces the workspace with a fresh copy of production. */
async function syncWorkspace() {
  await stopTest();
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
  const base: Record<string, string> = {};
  for (const x of SYNCED) if (existsSync(join(APP_DIR, x))) await cp(join(APP_DIR, x), join(WORKSPACE, x), { recursive: true });
  for (const rel of await files(APP_DIR)) base[rel] = hash(await readFile(join(APP_DIR, rel), 'utf8'));
  await writeMeta({ synced: new Date().toISOString(), base });
}

async function ensureWorkspace() {
  if (!existsSync(META)) await syncWorkspace();
}

/** Workspace files that differ from the production state they were copied from. */
async function changes(): Promise<Change[]> {
  await ensureWorkspace();
  const { base } = await readMeta();
  const out: Change[] = [];
  for (const rel of await files(WORKSPACE)) {
    const ws = await readFile(join(WORKSPACE, rel), 'utf8');
    if (base[rel] === hash(ws)) continue;
    const p = join(APP_DIR, rel);
    out.push({ rel, ws, prod: existsSync(p) ? await readFile(p, 'utf8') : null });
  }
  return out;
}

const changesHash = (cs: Change[]) => hash(cs.map(c => c.rel + '\0' + hash(c.ws)).sort().join('\n'));

/** Production files that changed (by hand) since the workspace was copied. */
async function conflicts(cs: Change[]) {
  const { base } = await readMeta();
  return cs.filter(c => (c.prod === null ? base[c.rel] !== undefined : hash(c.prod) !== base[c.rel])).map(c => c.rel);
}

/* ── diffs ─────────────────────────────────────────────────────────────────── */

/** Line diff (LCS) with 2 lines of context, for the approval card. */
function lineDiff(a: string[], b: string[]) {
  if (a.length * b.length > 4_000_000) return [`  (large file: ${a.length} → ${b.length} lines)`];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; ln: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: ' ', s: a[i], ln: j + 1 }); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: '-', s: a[i], ln: j + 1 }); i++; }
    else { ops.push({ t: '+', s: b[j], ln: j + 1 }); j++; }
  }
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some(x => x.t !== ' '));
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (!keep[k]) return;
    if (k > 0 && !keep[k - 1]) out.push(`  @ line ${o.ln}`);
    out.push(`${o.t} ${o.s}`);
  });
  return out;
}

const diffOf = (cs: Change[]) => cs.map(c => [
  `── ${c.rel}${c.prod === null ? ' (new file)' : ''}`,
  ...(c.prod === null ? norm(c.ws).split('\n').map(l => '+ ' + l) : lineDiff(norm(c.prod).split('\n'), norm(c.ws).split('\n'))),
].join('\n')).join('\n');

/* ── editing and checks ─────────────────────────────────────────────────────── */

function run(cmd: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    const t = setTimeout(() => kill(p), timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', e => { clearTimeout(t); res({ code: -1, out: String(e) }); });
    p.on('close', code => { clearTimeout(t); res({ code: code ?? -1, out }); });
  });
}

const clean = (out: string) => short(out.split(WORKSPACE + sep).join('').replace(/\x1b\[[0-9;]*m/g, '').trim(), 3000);
const typecheck = async () => {
  const r = await run(process.execPath, [join(APP_DIR, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(WORKSPACE, 'tsconfig.json')], WORKSPACE);
  return r.code === 0 ? null : clean(r.out);
};

/** Applies the edits to the workspace; rolls them back there if the workspace stops typechecking. */
async function editWorkspace(i: Input) {
  await ensureWorkspace();
  const next = new Map<string, { raw: string | null; text: string; crlf: boolean }>();
  for (const e of i.edits) {
    const rel = checkPath(e.path);
    let f = next.get(rel);
    if (!f) {
      const abs = join(WORKSPACE, rel);
      const raw = existsSync(abs) ? await readFile(abs, 'utf8') : null;
      f = { raw, text: raw === null ? '' : norm(raw), crlf: !!raw?.includes('\r\n') };
      next.set(rel, f);
    }
    if (!e.old) {
      if (f.raw !== null || f.text) throw new Error(`${rel} already exists. Give old_text to edit it.`);
      f.text = e.new;
      continue;
    }
    const at = f.text.indexOf(e.old);
    if (at < 0) throw new Error(`${rel}: old_text not found. Read the workspace file again and copy the text exactly.`);
    if (f.text.indexOf(e.old, at + 1) >= 0) throw new Error(`${rel}: old_text matches more than once. Include more surrounding lines.`);
    f.text = f.text.slice(0, at) + e.new + f.text.slice(at + e.old.length);
  }
  for (const [rel, f] of next) {
    await mkdir(dirname(join(WORKSPACE, rel)), { recursive: true });
    await writeFile(join(WORKSPACE, rel), f.crlf ? f.text.replace(/\n/g, '\r\n') : f.text);
  }
  const errors = await typecheck();
  if (errors) {
    for (const [rel, f] of next) {
      if (f.raw === null) await rm(join(WORKSPACE, rel), { force: true });
      else await writeFile(join(WORKSPACE, rel), f.raw);
    }
    throw new Error('the edit does not typecheck, so the workspace was left as it was. Fix these and try again:\n' + errors);
  }
  return [...next.keys()];
}

/* ── test instance ──────────────────────────────────────────────────────────── */

let test: { api: ChildProcess; web: ChildProcess; timer: NodeJS.Timeout } | null = null;
const TEST_LOG = join(TEST_DATA, 'test.log');

function kill(p: ChildProcess) {
  if (p.exitCode !== null || !p.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
  else p.kill('SIGTERM');
}

async function stopTest() {
  if (!test) return false;
  clearTimeout(test.timer);
  kill(test.api);
  kill(test.web);
  test = null;
  return true;
}
process.on('exit', () => { if (test) { kill(test.api); kill(test.web); } });

async function up(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** Runs the workspace's unit tests, then starts it as a separate instance with its own data. */
async function runTests() {
  await ensureWorkspace();
  await stopTest();
  const typeErrors = await typecheck();
  if (typeErrors) return { ok: false, text: 'Typecheck failed:\n' + typeErrors };
  const unit = await run(process.execPath, [join(APP_DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], WORKSPACE);
  if (unit.code !== 0) return { ok: false, text: 'Unit tests failed:\n' + clean(unit.out) };

  await mkdir(TEST_DATA, { recursive: true });
  await writeFile(TEST_LOG, '');
  const key = join(DATA_DIR, 'anthropic-key.bin');
  if (existsSync(key)) await copyFile(key, join(TEST_DATA, 'anthropic-key.bin'));
  const env = { ...process.env, PORT: String(TEST_API_PORT), JARVIS_API_PORT: String(TEST_API_PORT), JARVIS_DATA_DIR: TEST_DATA, JARVIS_TEST_INSTANCE: '1', JARVIS_SUPERVISED: '' };
  const log = (d: Buffer) => { appendFile(TEST_LOG, d).catch(() => undefined); };
  const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: WORKSPACE, env, windowsHide: true });
  const web = spawn(process.execPath, [join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(TEST_WEB_PORT), '--strictPort'], { cwd: WORKSPACE, env, windowsHide: true });
  for (const p of [api, web]) { p.stdout?.on('data', log); p.stderr?.on('data', log); }
  test = { api, web, timer: setTimeout(() => { stopTest(); }, TEST_TTL_MS) };

  const apiUp = await up(`http://localhost:${TEST_API_PORT}/api/health`, 45_000);
  const webUp = apiUp && await up(`http://localhost:${TEST_WEB_PORT}/`, 30_000);
  const logTail = clean((await readFile(TEST_LOG, 'utf8')).split('\n').slice(-30).join('\n'));
  if (!apiUp || !webUp) {
    await stopTest();
    return { ok: false, text: `The test instance did not start (${apiUp ? 'web' : 'API'} never answered).\nLog:\n${logTail}` };
  }
  return {
    ok: true,
    text: `Typecheck and unit tests passed. The test instance is running at http://localhost:${TEST_WEB_PORT}/ (API :${TEST_API_PORT}, its own data in ${TEST_DATA}); the live app is untouched. `
      + `Open it with browser_open to try the change (add ?demo=1 so it runs simulated tasks instead of real ones). Its log: ${TEST_LOG}. It stops by itself after 30 minutes.`,
  };
}

/* ── releases ───────────────────────────────────────────────────────────────── */

export const releasePending = (): Release | null => {
  try { return existsSync(RELEASE_FILE) ? JSON.parse(readFileSync(RELEASE_FILE, 'utf8')) : null; } catch { return null; }
};

/** Copies an approved release into production. Called when the user is idle or presses "Apply now". */
export async function applyRelease(): Promise<string> {
  return lock(async () => {
    const rel = releasePending();
    if (!rel) return 'No update waiting.';
    const cs = await changes();
    const drop = async (why: string) => {
      await rm(RELEASE_FILE, { force: true });
      store.toast({ kind: 'fix', task: rel.task, title: 'Update cancelled', text: why });
      changed();
      return why;
    };
    if (changesHash(cs) !== rel.hash) return drop('The workspace changed after you approved the update. Jarvis will ask again.');
    const bad = await conflicts(cs);
    if (bad.length) return drop(`Production changed since Jarvis copied it (${bad.join(', ')}). Jarvis needs to redo the change.`);

    const id = 'p' + Date.now().toString(36);
    const dir = join(ROOT, id);
    await mkdir(dir, { recursive: true });
    for (const c of cs) {
      if (c.prod === null) continue;
      await mkdir(dirname(join(dir, 'files', c.rel)), { recursive: true });
      await writeFile(join(dir, 'files', c.rel), c.prod);
    }
    const manifest: Manifest = { id, summary: rel.summary, task: rel.task, time: new Date().toISOString(), files: cs.map(c => ({ rel: c.rel, existed: c.prod !== null })) };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    await writeFile(join(dir, 'diff.txt'), rel.diff);
    audit({ task: rel.task, tool: 'self_release', patch: id, files: rel.files, summary: rel.summary });
    // Bookkeeping first: writing server files makes the supervisor restart this process.
    const meta = await readMeta();
    for (const c of cs) meta.base[c.rel] = hash(c.ws);
    await writeMeta(meta);
    await rm(RELEASE_FILE, { force: true });
    store.toast({ kind: 'fix', task: rel.task, title: 'Jarvis updated itself', text: short(rel.summary, 120) });
    changed();
    if (touchesServer(manifest.files)) await writeFile(PENDING_FILE, JSON.stringify({ id, time: manifest.time }));

    // Front end first (hot reload), then server files (the supervisor restarts the API).
    const ordered = [...cs].sort((a, b) => Number(a.rel.startsWith('server/')) - Number(b.rel.startsWith('server/')));
    try {
      for (const c of ordered) {
        await mkdir(dirname(join(APP_DIR, c.rel)), { recursive: true });
        await writeFile(join(APP_DIR, c.rel), c.ws);
      }
    } catch (e) {
      await restorePatch(id);
      await rm(PENDING_FILE, { force: true });
      throw e;
    }
    return `Applied update ${id}.`;
  });
}

const changed = () => store.emitEvent({ type: 'integrations' });

/** Applies an approved release once `idle()` says the user isn't in a session. */
export function startReleaseLoop(idle: () => boolean) {
  if (IS_TEST_INSTANCE) return;
  setInterval(() => {
    if (releasePending() && !busy && idle()) applyRelease().catch(e => console.error('Update failed:', e));
  }, 20_000);
}

/* ── tools ──────────────────────────────────────────────────────────────────── */

const guard = () => { if (IS_TEST_INSTANCE) throw new Error('this is the test instance; self-modification runs only in the live Jarvis.'); };

export const SELFMOD_TOOLS: ToolSpec<unknown>[] = [
  tool<Record<string, never>>({
    def: {
      name: 'self_workspace',
      description: `Self_Modification_Engine: your workspace, a full copy of your source at ${WORKSPACE} (the running app at ${APP_DIR} is production and is never edited directly). Returns the workspace path, the files you changed there, whether they were tested, and any update waiting to be applied. Call this first; read and edit the WORKSPACE copies of files.`,
      input_schema: { type: 'object', properties: {} },
    },
    parse: () => ({}),
    step: () => ({ kind: 'file', text: 'Opened its workspace' }),
    run: async () => {
      guard();
      await ensureWorkspace();
      const cs = await changes();
      const meta = await readMeta();
      const rel = releasePending();
      return [
        `Workspace: ${WORKSPACE} (copied from production ${meta.synced})`,
        cs.length ? `Changed vs production: ${cs.map(c => c.rel + (c.prod === null ? ' (new)' : '')).join(', ')}` : 'No changes vs production.',
        cs.length ? (meta.tested === changesHash(cs) ? 'Tested: yes (self_test passed on this exact state).' : 'Tested: no. Run self_test before self_release.') : '',
        test ? `Test instance running at http://localhost:${TEST_WEB_PORT}/` : 'Test instance: stopped.',
        rel ? `Update waiting to apply when the user is idle: ${rel.summary}` : '',
      ].filter(Boolean).join('\n');
    },
  }),
  tool<Input>({
    def: {
      name: 'self_propose_patch',
      description: 'Self_Modification_Engine: edit files in your workspace (not the live app). Read the workspace file with fs_read first. Each edit replaces old_text (copied exactly, matching once) with new_text; leave old_text empty to create a file. Paths are relative, e.g. src/useJarvis.ts. The workspace is typechecked after the edit; if it fails, the edit is undone and you get the errors. Then run self_test.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What changes and why' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
              required: ['path', 'old_text', 'new_text'],
            },
          },
        },
        required: ['summary', 'edits'],
      },
    },
    parse: parser(o => {
      if (!Array.isArray(o.edits) || !o.edits.length) throw new Error('"edits" must be a non-empty array');
      const edits = (o.edits as Record<string, unknown>[]).map(e => {
        if (typeof e?.old_text !== 'string' || typeof e?.new_text !== 'string') throw new Error('each edit needs old_text and new_text strings');
        return { path: str(e, 'path')!, old: norm(e.old_text), new: norm(e.new_text) };
      });
      edits.forEach(e => checkPath(e.path));
      return { summary: str(o, 'summary')!, edits };
    }),
    step: i => ({ kind: 'file', text: 'Edited its workspace: ' + short(i.summary, 100) }),
    run: async i => {
      guard();
      const rels = await lock(() => editWorkspace(i));
      return `Edited ${rels.join(', ')} in the workspace; it typechecks. The live app is unchanged. Run self_test next.`;
    },
  }),
  tool<Record<string, never>>({
    def: {
      name: 'self_test',
      description: `Self_Modification_Engine: typecheck and unit-test the workspace, then start it as a separate test instance at http://localhost:${TEST_WEB_PORT}/ with its own data, next to the live app. Use browser_open on it to check your change works. Required before self_release.`,
      input_schema: { type: 'object', properties: {} },
    },
    parse: () => ({}),
    step: () => ({ kind: 'think', text: 'Testing its changes in a separate test instance' }),
    run: async () => {
      guard();
      return lock(async () => {
        const r = await runTests();
        if (r.ok) {
          const meta = await readMeta();
          meta.tested = changesHash(await changes());
          await writeMeta(meta);
        }
        return { text: r.text, isError: !r.ok };
      });
    },
  }),
  tool<Record<string, never>>({
    def: {
      name: 'self_test_stop',
      description: 'Self_Modification_Engine: stop the workspace test instance.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: () => ({}),
    step: () => null,
    run: async () => ((await stopTest()) ? 'Test instance stopped.' : 'The test instance was not running.'),
  }),
  tool<{ summary: string }>({
    def: {
      name: 'self_release',
      description: 'Self_Modification_Engine: ask the user to approve moving your tested workspace changes into the live app. They see the full diff. Once approved, the update is applied automatically when they are idle (no running tasks, no recent activity), so the live app never restarts in the middle of their session. Call it once the change is tested, then report.',
      input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'What the update changes, for the user' } }, required: ['summary'] },
    },
    parse: parser(o => ({ summary: str(o, 'summary')! })),
    step: () => null,
    gate: async i => {
      guard();
      const cs = await changes();
      if (!cs.length) throw new Error('the workspace has no changes to release');
      if ((await readMeta()).tested !== changesHash(cs)) throw new Error('these workspace changes have not passed self_test yet. Run it first.');
      const bad = await conflicts(cs);
      if (bad.length) throw new Error(`production changed since the workspace was copied (${bad.join(', ')}). Call self_workspace_reset, redo the change and test again.`);
      return {
        action: 'Update Jarvis: ' + short(i.summary, 90), risk: 'Patch',
        detail: `${cs.length} file${cs.length === 1 ? '' : 's'} · typecheck, unit tests and test instance passed · applies when you're idle, never mid-session · revertible`,
        preview: diffOf(cs),
      };
    },
    run: async (i, ctx) => {
      const cs = await changes();
      const release: Release = { summary: i.summary, files: cs.map(c => c.rel), hash: changesHash(cs), time: new Date().toISOString(), task: ctx.taskId, diff: diffOf(cs) };
      await writeFile(RELEASE_FILE, JSON.stringify(release, null, 1));
      await stopTest();
      store.toast({ kind: 'fix', task: ctx.taskId, title: 'Update ready', text: "Jarvis will apply it when you're idle. Apps → Self-modification → Apply now to do it sooner." });
      changed();
      return 'Approved. The update applies when the user is idle; nothing restarts during their session. Report now.';
    },
  }),
  tool<Record<string, never>>({
    def: {
      name: 'self_workspace_reset',
      description: 'Self_Modification_Engine: discard all workspace changes and copy production again. Use when production changed under you or you want to start over.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: () => ({}),
    step: () => ({ kind: 'file', text: 'Reset its workspace to the live code' }),
    run: async () => {
      guard();
      await lock(syncWorkspace);
      await rm(RELEASE_FILE, { force: true });
      changed();
      return `Workspace reset to production at ${WORKSPACE}.`;
    },
  }),
  tool<Record<string, never>>({
    def: {
      name: 'self_list_patches',
      description: 'Self_Modification_Engine: list the updates applied to the live Jarvis, newest first, with their ids.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: () => ({}),
    step: () => ({ kind: 'file', text: 'Checked its own change history' }),
    run: async () => {
      const list = await manifests();
      return list.length
        ? list.map(m => `${m.id} · ${m.time}${m.reverted ? ' · REVERTED' : ''} · ${m.summary} (${m.files.map(f => f.rel).join(', ')})`).join('\n')
        : 'No updates yet.';
    },
  }),
  tool<{ id: string }>({
    def: {
      name: 'self_revert_patch',
      description: 'Self_Modification_Engine: undo an applied update by id in the live app, restoring its files (files it created are deleted). Asks the user first, and resets the workspace to match.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    parse: parser(o => ({ id: str(o, 'id')! })),
    step: i => ({ kind: 'fix', text: 'Reverted its update ' + i.id }),
    gate: async i => {
      guard();
      const m = (await manifests()).find(x => x.id === i.id);
      if (!m) throw new Error(`no update ${i.id}. Call self_list_patches.`);
      if (m.reverted) throw new Error(`update ${i.id} was already reverted`);
      return { action: 'Revert Jarvis update: ' + short(m.summary, 80), risk: 'Patch', detail: `Restores ${m.files.map(f => f.rel).join(', ')}${touchesServer(m.files) ? ' · Jarvis restarts now' : ''}`, preview: m.summary };
    },
    run: async (i, ctx) => {
      const m = await readManifest(i.id);
      audit({ task: ctx.taskId, tool: 'self_revert_patch', patch: i.id });
      const after = async () => { await restorePatch(i.id); await lock(syncWorkspace); };
      if (!touchesServer(m.files)) {
        await after();
        return `Reverted ${i.id}; the workspace was reset to match.`;
      }
      store.update(ctx.taskId, t => ({ ...t, report: { summary: `Reverted update ${i.id}: ${m.summary}`, nextSteps: ['Jarvis restarted to apply the revert.'] } }));
      setTimeout(() => { after().catch(e => console.error('Revert failed:', e)); }, 1500);
      return { text: `Reverting ${i.id}; Jarvis restarts.`, final: true };
    },
  }),
];
