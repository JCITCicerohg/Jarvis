import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider, KeyStatus, ProviderInfo, SetupInput } from '../../src/types.ts';
import { DATA_DIR } from '../paths.ts';
import { protect, unprotect } from './tools/dpapi.ts';

/* ── AI providers. Anthropic uses its SDK; the others speak the OpenAI chat-completions API (see llm.ts).
   Keys are entered in the app's setup screen and saved DPAPI-encrypted at data/<provider>-key.bin; the env
   vars below still work as a fallback. The chosen provider, models and base URL are in data/ai-provider.json. ── */
export const PROVIDERS: Record<AiProvider, { name: string; short: string; model: string; baseUrl: string; env: string; keyUrl: string; needsKey: boolean }> = {
  anthropic: { name: 'Anthropic Claude', short: 'Claude', model: 'claude-haiku-4-5', baseUrl: '', env: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys', needsKey: true },
  openai: { name: 'OpenAI', short: 'OpenAI', model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', needsKey: true },
  gemini: { name: 'Google Gemini', short: 'Gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey', needsKey: true },
  azure: { name: 'Azure OpenAI', short: 'Azure', model: '', baseUrl: '', env: 'AZURE_OPENAI_API_KEY', keyUrl: 'https://portal.azure.com', needsKey: true },
  compatible: { name: 'Local / OpenAI-compatible', short: 'Local', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', env: 'OPENAI_COMPATIBLE_API_KEY', keyUrl: '', needsKey: false },
};
const IDS = Object.keys(PROVIDERS) as AiProvider[];
export const isProvider = (p: unknown): p is AiProvider => typeof p === 'string' && IDS.includes(p as AiProvider);

interface Settings { provider: AiProvider; models: Partial<Record<AiProvider, string>>; baseUrl?: string; baseUrls?: Partial<Record<AiProvider, string>> }
const SETTINGS_FILE = join(DATA_DIR, 'ai-provider.json');
let settings: Settings = { provider: 'anthropic', models: {} };
try { if (existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) { console.error('Could not read ai-provider.json:', (e as Error).message); }
if (!isProvider(settings.provider)) settings.provider = 'anthropic';

const keyFile = (p: AiProvider) => join(DATA_DIR, `${p}-key.bin`);
const appKeys: Partial<Record<AiProvider, string>> = {};
let current: Anthropic | null = null;

export const keyReady: Promise<void> = (async () => {
  for (const p of IDS) {
    try { if (existsSync(keyFile(p))) appKeys[p] = await unprotect(readFileSync(keyFile(p), 'utf8')); } catch (e) { console.error(`Could not read the saved ${p} API key:`, (e as Error).message); }
  }
})();

const keyOf = (p: AiProvider) => appKeys[p] || process.env[PROVIDERS[p].env] || '';
const modelOf = (p: AiProvider) => settings.models[p] || PROVIDERS[p].model;

/** Azure OpenAI's v1 API root for a resource endpoint, whatever suffix the user pasted. */
export const azureBase = (endpoint: string) => endpoint.trim().replace(/\/+$/, '').replace(/\/openai(\/.*)?$/, '') + '/openai/v1';
/** Request auth for an OpenAI-style provider: Azure uses api-key, the rest a Bearer token. */
export const authHeaders = (p: AiProvider, key: string): Record<string, string> =>
  (!key ? {} : p === 'azure' ? { 'api-key': key } : { Authorization: 'Bearer ' + key });
const savedBase = (p: AiProvider) => settings.baseUrls?.[p] || (p === 'compatible' ? settings.baseUrl : undefined);
const baseOf = (p: AiProvider) =>
  (p === 'azure' ? (savedBase('azure') ? azureBase(savedBase('azure')!) : '') : (p === 'compatible' && savedBase(p)) || PROVIDERS[p].baseUrl);
const ready = (p: AiProvider) => (!!keyOf(p) || !PROVIDERS[p].needsKey) && (p !== 'azure' || (!!baseOf(p) && !!modelOf(p)));

export class NotConfiguredError extends Error {
  constructor() { super(`No ${PROVIDERS[settings.provider].name} API key. Add one in Jarvis setup.`); }
}

export interface Active { provider: AiProvider; model: string; key: string; baseUrl: string }

/** The provider, model and key every model call uses. Throws NotConfiguredError when the key is missing. */
export function active(): Active {
  const p = settings.provider;
  if (!ready(p)) throw new NotConfiguredError();
  return { provider: p, model: modelOf(p), key: keyOf(p), baseUrl: baseOf(p) };
}

/** The shared Anthropic client for a key. */
export function claude(key = keyOf('anthropic')): Anthropic {
  if (!key) throw new NotConfiguredError();
  if (current?.apiKey !== key) current = new Anthropic({ apiKey: key });
  return current;
}

function info(p: AiProvider): ProviderInfo {
  const d = PROVIDERS[p], key = keyOf(p);
  return {
    id: p, name: d.name, short: d.short, configured: ready(p), source: appKeys[p] ? 'app' : key ? 'env' : null, hint: key ? '…' + key.slice(-4) : '',
    model: modelOf(p), defaultModel: d.model, baseUrl: baseOf(p), needsKey: d.needsKey, keyUrl: d.keyUrl, env: d.env,
  };
}

export function keyStatus(): KeyStatus {
  const cur = info(settings.provider);
  return { configured: cur.configured, source: cur.source, hint: cur.hint, provider: cur.id, model: cur.model, providers: IDS.map(info) };
}

/** fetch, with network failures reported as the SDK's APIConnectionError (so they don't start a self-repair). */
export async function http(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new Anthropic.APIConnectionError({ message: `Couldn't reach ${url}: ${(e as Error).message}`, cause: e as Error });
  }
}

/** An HTTP error response as the matching SDK error class (AuthenticationError, RateLimitError, …). */
export async function httpError(res: Response) {
  const text = await res.text().catch(() => '');
  let body: object | undefined;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return Anthropic.APIError.generate(res.status, body, text.slice(0, 500) || res.statusText, res.headers);
}

async function fetchModels(p: AiProvider, key: string, base: string): Promise<string[]> {
  if (p === 'anthropic') return (await new Anthropic({ apiKey: key }).models.list({ limit: 100 })).data.map(m => m.id);
  const res = await http(base + '/models', { headers: authHeaders(p, key), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return []; // some local servers have no model list
  if (!res.ok) throw await httpError(res);
  const data = (await res.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map(m => String(m.id ?? '').replace(/^models\//, '')).filter(Boolean).sort();
}

/** Model ids the provider offers, for the setup screen's picker. Empty when it can't be listed. */
export async function listModels(p: AiProvider, baseUrl = ''): Promise<string[]> {
  const key = keyOf(p);
  if (!key && PROVIDERS[p].needsKey) return [];
  try { return await fetchModels(p, key, (p === 'compatible' && baseUrl.replace(/\/+$/, '')) || (p === 'azure' && baseUrl ? azureBase(baseUrl) : '') || baseOf(p)); } catch { return []; }
}

/** Checks the provider with the key, then saves the key (encrypted), the model and the provider choice. */
export async function saveKey(input: SetupInput) {
  const p = input.provider ?? settings.provider;
  if (!isProvider(p)) throw new Error('Unknown AI provider.');
  const d = PROVIDERS[p];
  const key = (input.apiKey ?? '').trim(), model = (input.model ?? '').trim(), baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const urlProvider = p === 'compatible' || p === 'azure';
  if (urlProvider && baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('The URL has to start with http:// or https://.');
  if (p === 'azure' && !baseUrl && !savedBase('azure')) throw new Error('Enter your Azure OpenAI endpoint, e.g. https://<resource>.openai.azure.com.');
  if (p === 'azure' && !model && !settings.models.azure) throw new Error('Enter the Azure deployment name as the model.');
  const useKey = key || keyOf(p);
  const base = p === 'azure' ? azureBase(baseUrl || savedBase('azure')!) : (p === 'compatible' && baseUrl) || baseOf(p);
  if (!useKey && d.needsKey) throw new Error('Enter an API key.');
  try {
    await fetchModels(p, useKey, base);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || (p === 'gemini' && e instanceof Anthropic.BadRequestError)) throw new Error(`${d.name} rejected that key. Check it and try again.`);
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("That key doesn't have access to the API.");
    if (e instanceof Anthropic.APIConnectionError) throw new Error(`Couldn't reach ${d.name}${urlProvider ? ' at ' + base : ''}. Check the connection${urlProvider ? ' and that the server is running' : ''}.`);
    if (e instanceof Anthropic.APIError) throw new Error(`${d.name} answered ${e.status ?? 'with an error'} when checking the key.`);
    throw e;
  }
  if (key) {
    writeFileSync(keyFile(p), await protect(key));
    appKeys[p] = key;
  }
  settings = {
    ...settings, provider: p,
    models: { ...settings.models, [p]: model || (p === 'azure' ? settings.models.azure : undefined) },
    ...(urlProvider && baseUrl ? { baseUrls: { ...settings.baseUrls, [p]: baseUrl } } : {}),
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function clearKey(p: AiProvider = settings.provider) {
  rmSync(keyFile(p), { force: true });
  delete appKeys[p];
}
