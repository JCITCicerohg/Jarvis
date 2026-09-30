import { PublicClientApplication, type AccountInfo, type ICachePlugin, type TokenCacheContext } from '@azure/msal-node';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Approval } from '../../../src/types.ts';
import { DATA_DIR, audit } from '../../paths.ts';
import { protect, unprotect } from './dpapi.ts';
import { resolvePath } from './os.ts';
import { num, parser, short, str, strs, tool, type ToolSpec } from './spec.ts';

/* ── Auth: device code flow, DPAPI-encrypted token cache ──────────────────────── */

const SCOPES = [
  'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite.All', 'Sites.Read.All',
  'Chat.ReadWrite', 'ChannelMessage.Send', 'Team.ReadBasic.All', 'Channel.ReadBasic.All',
];
const CACHE_FILE = join(DATA_DIR, 'msal-cache.bin');
export const DOWNLOADS = join(DATA_DIR, 'downloads');

export const graphConfigured = () => !!process.env.MS_CLIENT_ID;

let memCache: string | null = null;
const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    if (memCache === null) {
      memCache = '';
      if (existsSync(CACHE_FILE)) {
        try { memCache = await unprotect(await readFile(CACHE_FILE, 'utf8')); } catch (e) { console.warn('Could not decrypt Microsoft token cache', e); }
      }
    }
    if (memCache) ctx.tokenCache.deserialize(memCache);
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (!ctx.cacheHasChanged) return;
    memCache = ctx.tokenCache.serialize();
    await writeFile(CACHE_FILE, await protect(memCache));
  },
};

let pca: PublicClientApplication | null = null;
function app() {
  if (!graphConfigured()) throw new Error('Microsoft 365 is not configured. Set MS_CLIENT_ID (and MS_TENANT_ID) in .env.');
  pca ??= new PublicClientApplication({
    auth: { clientId: process.env.MS_CLIENT_ID!, authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'organizations'}` },
    cache: { cachePlugin },
  });
  return pca;
}

export async function graphAccount(): Promise<AccountInfo | null> {
  if (!graphConfigured()) return null;
  const accounts = await app().getAllAccounts();
  return accounts[0] ?? null;
}

export interface DeviceCode { userCode: string; verificationUri: string; message: string }
let pending: Promise<void> | null = null;

/** Starts the device code sign-in; `onCode` receives the code to show the user. */
export function graphSignIn(onCode: (c: DeviceCode) => void): Promise<void> {
  pending ??= app()
    .acquireTokenByDeviceCode({ scopes: SCOPES, deviceCodeCallback: r => onCode({ userCode: r.userCode, verificationUri: r.verificationUri, message: r.message }) })
    .then(() => undefined)
    .finally(() => { pending = null; });
  return pending;
}

export async function graphSignOut() {
  const a = app();
  for (const acc of await a.getAllAccounts()) await a.getTokenCache().removeAccount(acc);
}

async function token(): Promise<string> {
  const account = await graphAccount();
  if (!account) throw new Error('Microsoft 365 is not connected. Ask the user to connect it in Apps.');
  try {
    return (await app().acquireTokenSilent({ account, scopes: SCOPES })).accessToken;
  } catch {
    throw new Error('The Microsoft 365 session expired. Ask the user to reconnect it in Apps.');
  }
}

/* ── REST helper ──────────────────────────────────────────────────────────────── */

interface GraphOpts { method?: string; body?: unknown; raw?: Buffer | string; contentType?: string; signal?: AbortSignal; binary?: boolean }

export async function graph<T = unknown>(path: string, o: GraphOpts = {}): Promise<T> {
  const url = path.startsWith('https://') ? path : 'https://graph.microsoft.com/v1.0' + path;
  const res = await fetch(url, {
    method: o.method ?? 'GET',
    headers: {
      Authorization: 'Bearer ' + (await token()),
      ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : o.contentType ? { 'Content-Type': o.contentType } : {}),
      ConsistencyLevel: 'eventual',
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : typeof o.raw === 'string' ? o.raw : o.raw ? new Uint8Array(o.raw) : undefined,
    signal: o.signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep status text */ }
    throw new Error(`Graph ${res.status}: ${msg}`);
  }
  if (o.binary) return Buffer.from(await res.arrayBuffer()) as T;
  if (res.status === 204 || res.status === 202) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? await res.json() : await res.text()) as T;
}

/* ── Formatting ───────────────────────────────────────────────────────────────── */

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const addr = (a?: Rec) => (a?.emailAddress ? `${a.emailAddress.name ?? ''} <${a.emailAddress.address}>`.trim() : '');
const html2text = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
const recipients = (list: string[]) => list.map(address => ({ emailAddress: { address } }));
const itemPath = (i: { item_id?: string; drive_id?: string; path?: string }) =>
  i.item_id ? `${i.drive_id ? `/drives/${i.drive_id}` : '/me/drive'}/items/${i.item_id}` : `/me/drive/root:/${encodeURI(i.path!.replace(/^\/+/, ''))}:`;

/* ── Tools ────────────────────────────────────────────────────────────────────── */

type Item = { item_id?: string; drive_id?: string; path?: string };
const itemSchema = {
  item_id: { type: 'string' }, drive_id: { type: 'string', description: 'Needed for SharePoint items from files_search' },
  path: { type: 'string', description: 'OneDrive path like "Ops/Weekly/summary.docx" (alternative to item_id)' },
};
const parseItem = (o: Record<string, unknown>): Item => {
  const it = { item_id: str(o, 'item_id', false), drive_id: str(o, 'drive_id', false), path: str(o, 'path', false) };
  if (!it.item_id && !it.path) throw new Error('item_id or path is required');
  return it;
};

export const GRAPH_TOOLS: ToolSpec<unknown>[] = [
  tool<{ query?: string; folder?: string; top: number }>({
    def: {
      name: 'mail_search',
      description: 'Microsoft_Graph_API: search or list Outlook mail. Returns id, from, subject, received time and a preview.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'KQL search, e.g. "from:dana subject:P&L"' }, folder: { type: 'string', description: 'inbox, sentitems, drafts…' }, top: { type: 'number' } } },
    },
    parse: parser(o => ({ query: str(o, 'query', false), folder: str(o, 'folder', false), top: Math.min(num(o, 'top') ?? 15, 50) })),
    step: i => ({ kind: 'api', text: i.query ? 'Searched Outlook for ' + short(i.query, 80) : 'Listed Outlook ' + (i.folder ?? 'inbox') }),
    run: async (i, ctx) => {
      const base = i.folder ? `/me/mailFolders/${i.folder}/messages` : '/me/messages';
      const q = new URLSearchParams({ $top: String(i.top), $select: 'id,from,subject,receivedDateTime,bodyPreview,isRead,hasAttachments' });
      if (i.query) q.set('$search', `"${i.query.replace(/"/g, '')}"`); else q.set('$orderby', 'receivedDateTime desc');
      const r = await graph<{ value: Rec[] }>(`${base}?${q}`, { signal: ctx.signal });
      return r.value.map(m => `- [${m.id}] ${m.receivedDateTime} · ${addr(m.from)} · ${m.subject}${m.hasAttachments ? ' 📎' : ''}\n  ${short(m.bodyPreview ?? '', 200)}`).join('\n') || 'No messages.';
    },
  }),
  tool<{ id: string }>({
    def: { name: 'mail_read', description: 'Microsoft_Graph_API: read one email in full, with attachment names.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    parse: parser(o => ({ id: str(o, 'id')! })),
    step: () => ({ kind: 'api', text: 'Read an email in Outlook' }),
    run: async (i, ctx) => {
      const m = await graph<Rec>(`/me/messages/${i.id}?$expand=attachments($select=name,size)`, { signal: ctx.signal });
      return [`From: ${addr(m.from)}`, `To: ${(m.toRecipients ?? []).map(addr).join(', ')}`, `Date: ${m.receivedDateTime}`, `Subject: ${m.subject}`,
        (m.attachments ?? []).length ? `Attachments: ${m.attachments.map((a: Rec) => a.name).join(', ')}` : '',
        '', short(m.body?.contentType === 'html' ? html2text(m.body.content) : m.body?.content ?? '', 12_000)].filter(Boolean).join('\n');
    },
  }),
  tool<{ to: string[]; cc: string[]; subject: string; body: string; replyTo?: string }>({
    def: {
      name: 'mail_draft',
      description: 'Microsoft_Graph_API: create an Outlook draft (nothing is sent). Use mail_send_draft to send it after.',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' }, reply_to_id: { type: 'string', description: 'Message id to reply to' } },
        required: ['subject', 'body'],
      },
    },
    parse: parser(o => ({ to: strs(o, 'to'), cc: strs(o, 'cc'), subject: str(o, 'subject')!, body: str(o, 'body')!, replyTo: str(o, 'reply_to_id', false) })),
    step: i => ({ kind: 'api', text: 'Drafted email: ' + short(i.subject, 90) }),
    run: async (i, ctx) => {
      const content = { body: { contentType: 'Text', content: i.body }, toRecipients: recipients(i.to), ccRecipients: recipients(i.cc) };
      const d = i.replyTo
        ? await graph<Rec>(`/me/messages/${i.replyTo}/createReply`, { method: 'POST', body: { message: content }, signal: ctx.signal })
        : await graph<Rec>('/me/messages', { method: 'POST', body: { subject: i.subject, ...content }, signal: ctx.signal });
      return `Draft created. draft_id: ${d.id}`;
    },
  }),
  tool<{ id: string }>({
    def: { name: 'mail_send_draft', description: 'Microsoft_Graph_API: send an Outlook draft. The user approves every send.', input_schema: { type: 'object', properties: { draft_id: { type: 'string' } }, required: ['draft_id'] } },
    parse: parser(o => ({ id: str(o, 'draft_id')! })),
    step: () => ({ kind: 'api', text: 'Sent the email via Outlook' }),
    gate: async (i): Promise<Approval> => {
      const d = await graph<Rec>(`/me/messages/${i.id}?$select=subject,toRecipients,ccRecipients,body`);
      const to = [...(d.toRecipients ?? []), ...(d.ccRecipients ?? [])];
      return {
        action: 'Send email: ' + short(d.subject ?? '(no subject)', 60), risk: 'Send',
        detail: `${to.length} recipient${to.length === 1 ? '' : 's'} · ${to.map(addr).join(', ')}`,
        preview: short(d.body?.contentType === 'html' ? html2text(d.body.content) : d.body?.content ?? '', 1500),
      };
    },
    run: async (i, ctx) => {
      await graph(`/me/messages/${i.id}/send`, { method: 'POST', signal: ctx.signal });
      audit({ task: ctx.taskId, tool: 'mail_send_draft', draft: i.id });
      return 'Sent';
    },
  }),
  tool<{ start: string; end: string }>({
    def: {
      name: 'calendar_list',
      description: 'Microsoft_Graph_API: list calendar events between two ISO datetimes.',
      input_schema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
    },
    parse: parser(o => ({ start: str(o, 'start')!, end: str(o, 'end')! })),
    step: () => ({ kind: 'api', text: 'Checked the Outlook calendar' }),
    run: async (i, ctx) => {
      const q = new URLSearchParams({ startDateTime: i.start, endDateTime: i.end, $top: '100', $orderby: 'start/dateTime', $select: 'subject,start,end,location,attendees,organizer,isOnlineMeeting' });
      const r = await graph<{ value: Rec[] }>(`/me/calendarView?${q}`, { signal: ctx.signal });
      return r.value.map(e => `- ${e.start.dateTime}–${e.end.dateTime} (${e.start.timeZone}) · ${e.subject}${e.location?.displayName ? ' @ ' + e.location.displayName : ''} · ${(e.attendees ?? []).length} attendees`).join('\n') || 'No events.';
    },
  }),
  tool<{ subject: string; start: string; end: string; timeZone: string; attendees: string[]; body?: string; location?: string; online: boolean }>({
    def: {
      name: 'calendar_create_event',
      description: 'Microsoft_Graph_API: create a calendar event. With attendees, invites are sent, so the user approves first.',
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' }, start: { type: 'string', description: 'ISO local datetime' }, end: { type: 'string' },
          time_zone: { type: 'string', description: 'Windows or IANA zone, default UTC' }, attendees: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' }, location: { type: 'string' }, online_meeting: { type: 'boolean' },
        },
        required: ['subject', 'start', 'end'],
      },
    },
    parse: parser(o => ({
      subject: str(o, 'subject')!, start: str(o, 'start')!, end: str(o, 'end')!, timeZone: str(o, 'time_zone', false) ?? 'UTC',
      attendees: strs(o, 'attendees'), body: str(o, 'body', false), location: str(o, 'location', false), online: o.online_meeting === true,
    })),
    step: i => ({ kind: 'api', text: 'Created calendar event: ' + short(i.subject, 80) }),
    gate: i => (i.attendees.length ? {
      action: `Send ${i.attendees.length} invite${i.attendees.length === 1 ? '' : 's'}: ${short(i.subject, 50)}`, risk: 'Send',
      detail: `${i.start} → ${i.end} (${i.timeZone})`, preview: i.attendees.join('\n'),
    } : null),
    run: async (i, ctx) => {
      const e = await graph<Rec>('/me/events', {
        method: 'POST', signal: ctx.signal,
        body: {
          subject: i.subject, start: { dateTime: i.start, timeZone: i.timeZone }, end: { dateTime: i.end, timeZone: i.timeZone },
          attendees: i.attendees.map(address => ({ emailAddress: { address }, type: 'required' })),
          ...(i.body ? { body: { contentType: 'Text', content: i.body } } : {}),
          ...(i.location ? { location: { displayName: i.location } } : {}), isOnlineMeeting: i.online,
        },
      });
      return `Event created: ${e.webLink ?? e.id}`;
    },
  }),
  tool<{ query: string }>({
    def: { name: 'files_search', description: 'Microsoft_Graph_API: search files across OneDrive and SharePoint. Returns item_id and drive_id for other file tools.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    parse: parser(o => ({ query: str(o, 'query')! })),
    step: i => ({ kind: 'api', text: 'Searched SharePoint and OneDrive for ' + short(i.query, 70) }),
    run: async (i, ctx) => {
      const r = await graph<Rec>('/search/query', { method: 'POST', signal: ctx.signal, body: { requests: [{ entityTypes: ['driveItem'], query: { queryString: i.query }, size: 20 }] } });
      const hits: Rec[] = r.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
      return hits.map(h => {
        const f = h.resource;
        return `- ${f.name} · item_id ${f.id} · drive_id ${f.parentReference?.driveId} · ${f.lastModifiedDateTime} · ${f.webUrl}`;
      }).join('\n') || 'No files found.';
    },
  }),
  tool<Item>({
    def: { name: 'file_list', description: 'Microsoft_Graph_API: list a OneDrive/SharePoint folder (use path "" for the OneDrive root).', input_schema: { type: 'object', properties: itemSchema } },
    parse: parser(o => ({ item_id: str(o, 'item_id', false), drive_id: str(o, 'drive_id', false), path: typeof o.path === 'string' ? o.path : '' })),
    step: i => ({ kind: 'api', text: 'Listed OneDrive folder ' + short(i.path || i.item_id || '/', 80) }),
    run: async (i, ctx) => {
      const base = i.item_id || i.path ? itemPath(i) : '/me/drive/root';
      const r = await graph<{ value: Rec[] }>(`${base}/children?$top=200&$select=id,name,size,folder,lastModifiedDateTime,parentReference`, { signal: ctx.signal });
      return r.value.map(f => `- ${f.folder ? 'dir ' : 'file'} ${f.name} · item_id ${f.id} · ${f.size} bytes · ${f.lastModifiedDateTime}`).join('\n') || 'Empty folder.';
    },
  }),
  tool<Item>({
    def: { name: 'file_download', description: 'Microsoft_Graph_API: download a OneDrive/SharePoint file to this PC and return its local path (then use fs_read or analytics_query on it).', input_schema: { type: 'object', properties: itemSchema } },
    parse: parser(parseItem),
    step: i => ({ kind: 'api', text: 'Downloaded ' + short(i.path ?? 'a file', 80) + ' from SharePoint/OneDrive' }),
    run: async (i, ctx) => {
      const meta = await graph<Rec>(`${itemPath(i)}?$select=name,size`, { signal: ctx.signal });
      const buf = await graph<Buffer>(`${itemPath(i)}/content`, { binary: true, signal: ctx.signal });
      await mkdir(DOWNLOADS, { recursive: true });
      const out = join(DOWNLOADS, basename(meta.name));
      await writeFile(out, buf);
      return `Saved ${buf.length} bytes to ${out}`;
    },
  }),
  tool<{ local: string; dest: string }>({
    def: {
      name: 'file_upload',
      description: 'Microsoft_Graph_API: upload a local file (up to 4 MB) to a OneDrive path. Replacing an existing file asks the user first.',
      input_schema: { type: 'object', properties: { local_path: { type: 'string' }, dest_path: { type: 'string', description: 'OneDrive path incl. file name' } }, required: ['local_path', 'dest_path'] },
    },
    parse: parser(o => ({ local: resolvePath(str(o, 'local_path')!), dest: str(o, 'dest_path')!.replace(/^\/+/, '') })),
    step: i => ({ kind: 'api', text: 'Uploaded to OneDrive › ' + short(i.dest, 90) }),
    gate: async i => {
      try {
        await graph(`/me/drive/root:/${encodeURI(i.dest)}:?$select=id`);
        return { action: 'Replace OneDrive file ' + short(i.dest, 60), detail: 'The current version will be overwritten (OneDrive keeps version history)', risk: 'Irreversible' };
      } catch { return null; }
    },
    run: async (i, ctx) => {
      const buf = await readFile(i.local);
      if (buf.length > 4 * 1024 * 1024) return { text: 'File is over 4 MB; large uploads are not supported yet.', isError: true };
      const r = await graph<Rec>(`/me/drive/root:/${encodeURI(i.dest)}:/content`, { method: 'PUT', raw: buf, contentType: 'application/octet-stream', signal: ctx.signal });
      audit({ task: ctx.taskId, tool: 'file_upload', dest: i.dest, bytes: buf.length });
      return `Uploaded: ${r.webUrl}`;
    },
  }),
  tool<Item>({
    def: { name: 'file_delete', description: 'Microsoft_Graph_API: delete a OneDrive/SharePoint item (goes to the recycle bin). The user approves first.', input_schema: { type: 'object', properties: itemSchema } },
    parse: parser(parseItem),
    step: () => ({ kind: 'api', text: 'Deleted a file in SharePoint/OneDrive' }),
    gate: async (i): Promise<Approval> => {
      const m = await graph<Rec>(`${itemPath(i)}?$select=name,webUrl,size`);
      return { action: 'Delete ' + short(m.name, 60), detail: 'Moves to the recycle bin · ' + m.webUrl, risk: 'Delete' };
    },
    run: async (i, ctx) => {
      await graph(itemPath(i), { method: 'DELETE', signal: ctx.signal });
      audit({ task: ctx.taskId, tool: 'file_delete', item: i });
      return 'Deleted (recoverable from the recycle bin)';
    },
  }),
  tool<Record<string, never>>({
    def: { name: 'teams_list', description: 'Microsoft_Graph_API: list your Teams chats and the channels of your teams, with ids for teams_send.', input_schema: { type: 'object', properties: {} } },
    parse: () => ({}),
    step: () => ({ kind: 'api', text: 'Listed Teams chats and channels' }),
    run: async (_i, ctx) => {
      const chats = await graph<{ value: Rec[] }>('/me/chats?$top=30&$expand=members', { signal: ctx.signal });
      const teams = await graph<{ value: Rec[] }>('/me/joinedTeams', { signal: ctx.signal });
      const lines = chats.value.map(c => `- chat ${c.id} · ${c.topic ?? (c.members ?? []).map((m: Rec) => m.displayName).join(', ')}`);
      for (const t of teams.value.slice(0, 10)) {
        const ch = await graph<{ value: Rec[] }>(`/teams/${t.id}/channels`, { signal: ctx.signal });
        lines.push(...ch.value.map(c => `- team ${t.id} channel ${c.id} · ${t.displayName} › ${c.displayName}`));
      }
      return lines.join('\n') || 'No chats or teams.';
    },
  }),
  tool<{ chat?: string; team?: string; channel?: string; text: string }>({
    def: {
      name: 'teams_send',
      description: 'Microsoft_Graph_API: post a message to a Teams chat (chat_id) or channel (team_id + channel_id). The user approves every send.',
      input_schema: { type: 'object', properties: { chat_id: { type: 'string' }, team_id: { type: 'string' }, channel_id: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
    },
    parse: parser(o => {
      const r = { chat: str(o, 'chat_id', false), team: str(o, 'team_id', false), channel: str(o, 'channel_id', false), text: str(o, 'text')! };
      if (!r.chat && !(r.team && r.channel)) throw new Error('chat_id, or team_id and channel_id, is required');
      return r;
    }),
    step: () => ({ kind: 'api', text: 'Posted a message in Teams' }),
    gate: i => ({ action: 'Post in Teams', detail: i.chat ? 'To a chat' : 'To a channel', risk: 'Send', preview: short(i.text, 1500) }),
    run: async (i, ctx) => {
      const path = i.chat ? `/chats/${i.chat}/messages` : `/teams/${i.team}/channels/${i.channel}/messages`;
      await graph(path, { method: 'POST', body: { body: { contentType: 'text', content: i.text } }, signal: ctx.signal });
      audit({ task: ctx.taskId, tool: 'teams_send', target: i.chat ?? `${i.team}/${i.channel}` });
      return 'Posted';
    },
  }),
  tool<{ path: string }>({
    def: { name: 'graph_get', description: 'Microsoft_Graph_API: read-only GET of any Graph v1.0 path (e.g. "/me", "/me/people?$top=10") for anything the other tools do not cover.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    parse: parser(o => {
      const path = str(o, 'path')!;
      if (!path.startsWith('/')) throw new Error('path must start with /');
      return { path };
    }),
    step: i => ({ kind: 'api', text: 'Read Graph ' + short(i.path.split('?')[0], 80) }),
    run: async (i, ctx) => short(JSON.stringify(await graph(i.path, { signal: ctx.signal }), null, 1), 20_000),
  }),
];
