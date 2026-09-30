import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { ServerEvent } from '../src/types.ts';
import { NotConfiguredError, clearKey, isProvider, keyReady, keyStatus, listModels, saveKey } from './agent/claude.ts';
import { isOwnBug, reportIncident, startAutofix } from './agent/autofix.ts';
import { stopAll } from './agent/runner.ts';
import { applyRelease, startReleaseLoop } from './agent/tools/selfmod.ts';
import { memoryGraph } from './agent/tools/memory.ts';
import { onAdminLost, stopAdminWorker } from './agent/tools/os.ts';
import { chat, type ChatBody } from './chat.ts';
import { integrationGroups, updateIntegration } from './integrations.ts';
import { store } from './state.ts';

onAdminLost(() => store.setAdmin(false));

const PORT = Number(process.env.PORT) || 8787;
const app = express();
app.use(express.json({ limit: '1mb' }));

/* "In session": the user did something in the last few minutes, or a task is running.
   Self-modification updates wait until neither is true. */
const IDLE_MS = 3 * 60_000;
let lastActivity = Date.now();
app.use((req, _res, next) => {
  if (req.method === 'POST' && !req.path.startsWith('/api/client-error')) lastActivity = Date.now();
  next();
});
const idle = () => Date.now() - lastActivity > IDLE_MS && !store.tasks.some(t => t.status !== 'done');

app.post('/api/activity', (_req, res) => { res.json({ ok: true }); });

app.post('/api/self/apply', async (_req, res) => {
  try {
    res.json({ message: await applyRelease() });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

/* In-app setup: the AI provider, model and API keys. Only accepted from this PC, keys never echoed back. */
const local = (req: express.Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/* Uncaught errors from the app in the browser, for self-repair. */
app.post('/api/client-error', (req, res) => {
  if (!local(req)) { res.status(403).end(); return; }
  const message = String(req.body?.message ?? '').slice(0, 1000);
  if (message) reportIncident({ source: 'client', error: message + '\n' + String(req.body?.stack ?? '').slice(0, 3000) });
  res.json({ ok: true });
});

app.get('/api/setup', (_req, res) => {
  res.json(keyStatus());
});

app.post('/api/setup', async (req, res) => {
  if (!local(req)) { res.status(403).json({ error: 'Set the API key from this PC.' }); return; }
  try {
    const b = req.body ?? {};
    if (b.provider !== undefined && !isProvider(b.provider)) throw new Error('Unknown AI provider.');
    await saveKey({ provider: b.provider, apiKey: String(b.apiKey ?? ''), model: String(b.model ?? ''), baseUrl: String(b.baseUrl ?? '') });
    res.json(keyStatus());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete('/api/setup', (req, res) => {
  if (!local(req)) { res.status(403).json({ error: 'Change the API key from this PC.' }); return; }
  clearKey(isProvider(req.query.provider) ? req.query.provider : undefined);
  res.json(keyStatus());
});

/* Model ids for the setup screen's picker, using the saved key. */
app.get('/api/setup/models', async (req, res) => {
  if (!local(req)) { res.status(403).json({ error: 'Only from this PC.' }); return; }
  const p = req.query.provider;
  if (!isProvider(p)) { res.status(400).json({ error: 'Unknown AI provider.' }); return; }
  res.json({ models: await listModels(p, typeof req.query.baseUrl === 'string' ? req.query.baseUrl : '') });
});

app.post('/api/chat', async (req, res) => {
  const body = req.body as ChatBody;
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    res.status(400).json({ error: 'messages required' });
    return;
  }
  try {
    res.json(await chat(body));
  } catch (e) {
    if (e instanceof NotConfiguredError) { res.status(409).json({ error: 'not_configured' }); return; }
    if (e instanceof Anthropic.RateLimitError) console.warn('Rate limited:', e.message);
    else if (e instanceof Anthropic.APIError) console.error(`API error ${e.status}:`, e.message);
    else console.error(e);
    if (isOwnBug(e)) reportIncident({ source: 'chat', error: e instanceof Error ? (e.stack || e.message) : String(e), context: 'Last user message: ' + String(body.messages.at(-1)?.text ?? '').slice(0, 500) });
    res.status(502).json({ error: 'model_unreachable' });
  }
});

/* Live mode: server-owned tasks streamed over SSE. */
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: ServerEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  send(store.snapshot());
  store.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); store.off('event', send); });
});

app.post('/api/tasks/:id/decide', (req, res) => {
  const ok = store.decide(req.params.id, !!req.body?.approve);
  res.status(ok ? 200 : 409).json({ ok });
});

app.post('/api/tasks/:id/answer', (req, res) => {
  const ok = store.answer(req.params.id, String(req.body?.text ?? ''));
  res.status(ok ? 200 : 409).json({ ok });
});

app.post('/api/tasks/:id/pause', (req, res) => {
  const t = store.update(req.params.id, x => (x.status === 'running' ? { ...x, paused: !x.paused } : x));
  res.status(t ? 200 : 404).json({ ok: !!t });
});

app.post('/api/stop', (_req, res) => {
  res.json({ stopped: stopAll() });
});

app.post('/api/admin/revoke', (_req, res) => {
  stopAdminWorker();
  store.setAdmin(false);
  res.json({ ok: true });
});

app.get('/api/memory', (_req, res) => {
  res.json(memoryGraph());
});

app.get('/api/integrations', async (_req, res) => {
  res.json(await integrationGroups());
});

app.post('/api/integrations/:id', async (req, res) => {
  try {
    await updateIntegration(req.params.id, req.body ?? {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

await keyReady;
app.listen(PORT, err => {
  if (err) {
    console.error(`Could not listen on port ${PORT}:`, err.message);
    process.exit(1);
  }
  console.log(`Jarvis API on http://localhost:${PORT}` + (keyStatus().configured ? '' : ' (no API key yet: add one in the app)'));
  startAutofix();
  startReleaseLoop(idle);
});
