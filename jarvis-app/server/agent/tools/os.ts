import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SERVER_DIR } from '../../paths.ts';

const IS_WIN = process.platform === 'win32';
const OUTPUT_CAP = 20_000;
export const DEFAULT_CWD = homedir();

export interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + `\n…[truncated ${s.length - OUTPUT_CAP} chars]` : s);
/** PowerShell -EncodedCommand takes base64 of UTF-16LE, which sidesteps all quoting. */
const encode = (cmd: string) => Buffer.from(cmd, 'utf16le').toString('base64');
/** Quiet progress bars (they leak as CLIXML on stderr) and emit UTF-8. */
const PREAMBLE = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ";
const wrap = (cmd: string) => PREAMBLE + cmd;

/** Turns PowerShell's serialized "#< CLIXML" stderr into plain error text. */
export function cleanStderr(s: string) {
  if (!s.startsWith('#< CLIXML')) return s;
  const errs = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1]);
  return errs.join('')
    .replace(/_x000D__x000A_/g, '\n').replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

export function resolvePath(p: string) { return resolve(DEFAULT_CWD, p.replace(/^~(?=$|[\\/])/, DEFAULT_CWD)); }

export function execShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise(res => {
    const child = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(wrap(command))], { cwd, windowsHide: true })
      : spawn('/bin/sh', ['-c', command], { cwd });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { if (stdout.length <= OUTPUT_CAP) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length <= OUTPUT_CAP) stderr += d; });
    const kill = () => {
      if (IS_WIN && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', e => { clearTimeout(timer); res({ stdout: '', stderr: String(e), exitCode: -1, timedOut: false }); });
    child.on('close', code => { clearTimeout(timer); res({ stdout: cap(stdout), stderr: cap(cleanStderr(stderr)), exitCode: code ?? -1, timedOut }); });
  });
}

/* ── Elevated worker: one UAC prompt per server session ─────────────────────────── */

interface Worker { socket: Socket; server: Server; waiters: Map<string, (r: ExecResult) => void> }
let worker: Worker | null = null;
let onLost: (() => void) | null = null;
/** Called when the elevated worker exits (UAC window closed, crash). */
export const onAdminLost = (fn: () => void) => { onLost = fn; };

export const adminAvailable = () => !!worker && !worker.socket.destroyed;

/** Launches the elevated worker. Resolves once it has connected, rejects if UAC is declined or it times out. */
export function startAdminWorker(): Promise<void> {
  if (!IS_WIN) return Promise.reject(new Error('Elevation is only implemented on Windows.'));
  if (adminAvailable()) return Promise.resolve();
  const pipe = 'jarvis-admin-' + randomBytes(6).toString('hex');
  const token = randomBytes(24).toString('hex');
  const script = join(SERVER_DIR, 'agent', 'tools', 'admin-worker.ps1');

  return new Promise((ok, fail) => {
    let settled = false;
    const done = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e) { server.close(); fail(e); } else ok();
    };
    const server = createServer(socket => {
      if (worker) { socket.destroy(); return; }
      let buf = '', authed = false;
      const waiters = new Map<string, (r: ExecResult) => void>();
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!authed) {
            if (msg.hello !== token) { socket.destroy(); return; }
            authed = true;
            worker = { socket, server, waiters };
            done();
            continue;
          }
          const w = waiters.get(String(msg.id));
          if (w) {
            waiters.delete(String(msg.id));
            w({ stdout: cap(String(msg.stdout ?? '')), stderr: cap(cleanStderr(String(msg.stderr ?? ''))), exitCode: Number(msg.exitCode ?? -1), timedOut: !!msg.timedOut });
          }
        }
      });
      socket.on('close', () => {
        for (const w of waiters.values()) w({ stdout: '', stderr: 'Elevated worker exited', exitCode: -1, timedOut: false });
        if (worker?.socket === socket) { worker = null; onLost?.(); }
      });
    });
    server.listen('\\\\.\\pipe\\' + pipe);
    const timer = setTimeout(() => done(new Error('The elevated worker did not connect within 90 seconds.')), 90_000);

    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${q(`"${script}"`)},'-Pipe',${q(pipe)},'-Token',${q(token)})`;
    const l = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launcher)], { windowsHide: true });
    let err = '';
    l.stderr.on('data', d => { err += d; });
    l.on('close', code => { if (code !== 0) done(new Error(/cancel/i.test(err) ? 'The UAC prompt was declined.' : 'Could not start the elevated worker: ' + err.trim())); });
  });
}

export function execElevated(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  if (!worker) return Promise.resolve({ stdout: '', stderr: 'Admin access has not been granted.', exitCode: -1, timedOut: false });
  const id = randomBytes(6).toString('hex');
  const w = worker;
  return new Promise(res => {
    w.waiters.set(id, res);
    w.socket.write(JSON.stringify({ id, encoded: encode(wrap(command)), cwd, timeoutMs }) + '\n');
  });
}

export function stopAdminWorker() {
  if (!worker) return;
  worker.socket.destroy();
  worker.server.close();
  worker = null;
}

/* ── File system ──────────────────────────────────────────────────────────────── */

export async function fsList(path: string) {
  const dir = resolvePath(path);
  const entries = await readdir(dir, { withFileTypes: true });
  const rows = await Promise.all(entries.slice(0, 300).map(async e => {
    const full = join(dir, e.name);
    try {
      const st = await stat(full);
      return `${e.isDirectory() ? 'dir ' : 'file'}  ${String(st.size).padStart(12)}  ${st.mtime.toISOString().slice(0, 16)}  ${e.name}`;
    } catch {
      return `?     ${''.padStart(12)}  ${''.padStart(16)}  ${e.name}`;
    }
  }));
  return `${dir} (${entries.length} entries${entries.length > 300 ? ', first 300 shown' : ''})\n` + rows.join('\n');
}

export async function fsRead(path: string, maxBytes = 100_000) {
  const buf = await readFile(resolvePath(path));
  const text = buf.subarray(0, maxBytes).toString('utf8');
  return buf.length > maxBytes ? text + `\n…[truncated, file is ${buf.length} bytes]` : text;
}

export async function fsExists(path: string) {
  try { await stat(resolvePath(path)); return true; } catch { return false; }
}

export async function fsWrite(path: string, content: string, append: boolean) {
  const full = resolvePath(path);
  await mkdir(dirname(full), { recursive: true });
  await (append ? appendFile(full, content) : writeFile(full, content));
  return `${append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(content)} bytes to ${full}`;
}
