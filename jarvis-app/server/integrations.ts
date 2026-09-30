import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Integration, IntegrationGroup, IntegrationPref } from '../src/types.ts';
import { browserChannel, browserOpen, closeBrowser } from './agent/tools/browser.ts';
import { graphAccount, graphConfigured, graphSignIn, graphSignOut, type DeviceCode } from './agent/tools/graph.ts';
import { DATA_DIR } from './paths.ts';
import { store } from './state.ts';
import { releasePending } from './agent/tools/selfmod.ts';

export type Engine = 'microsoft' | 'browser' | 'analytics' | 'selfmod';

const FILE = join(DATA_DIR, 'integrations.json');
interface Prefs { off: Engine[]; pref: Record<string, IntegrationPref> }
let prefs: Prefs = { off: [], pref: { toast: 'Both' } };
try { if (existsSync(FILE)) prefs = { ...prefs, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { /* defaults */ }
const save = () => writeFileSync(FILE, JSON.stringify(prefs, null, 1));

export const engineOn = (e: Engine) => !prefs.off.includes(e);

let code: DeviceCode | null = null;
let signInError = '';
const changed = () => store.emitEvent({ type: 'integrations' });

/** Which engine a tool belongs to, for the on/off switches. */
export function engineOf(tool: string): Engine | null {
  if (/^(mail|calendar|files?|teams|graph)_/.test(tool)) return 'microsoft';
  if (tool.startsWith('browser_')) return 'browser';
  if (tool.startsWith('analytics_')) return 'analytics';
  if (tool.startsWith('self_')) return 'selfmod';
  return null;
}

/** Why a tool can't run right now, or null. */
export async function engineBlocked(e: Engine): Promise<string | null> {
  if (!engineOn(e)) return `The user turned ${e === 'microsoft' ? 'Microsoft 365' : e === 'browser' ? 'browser automation' : e === 'selfmod' ? 'self-modification' : 'analytics'} off in Apps.`;
  if (e === 'microsoft' && !(await graphAccount())) return 'Microsoft 365 is not connected. Ask the user to connect it in Apps.';
  return null;
}

export async function integrationGroups(): Promise<IntegrationGroup[]> {
  let account = '';
  try { account = (await graphAccount())?.username ?? ''; } catch { /* not configured */ }
  const msOn = engineOn('microsoft') && !!account;
  const msLast = account ? `Signed in as ${account}` : !graphConfigured() ? 'Set MS_CLIENT_ID in .env to enable' : code ? 'Waiting for you to sign in' : signInError || 'Not connected';
  const ms = (id: string, name: string, icon: string, desc: string): Integration => ({
    id, name, icon, desc, modes: ['API'], on: msOn, last: msLast, engine: 'microsoft', available: graphConfigured(),
    ...(code ? { code: { userCode: code.userCode, verificationUri: code.verificationUri } } : {}),
  });
  const brOn = engineOn('browser');
  const brLast = !brOn ? 'Off' : browserOpen() ? 'Browser open' : `Via ${browserChannel() === 'msedge' ? 'Edge' : browserChannel()} automation`;
  const br = (id: string, name: string, icon: string, desc: string, modes: Integration['modes'] = ['Browser']): Integration => ({
    id, name, icon, desc, modes, on: brOn, last: brLast, engine: 'browser', available: true, ...(modes.length > 1 ? { pref: prefs.pref[id] ?? 'Both' } : {}),
  });
  const soon = (id: string, name: string, icon: string, desc: string): Integration => ({ id, name, icon, desc, modes: ['API'], on: false, last: 'Not available yet', available: false });

  return [
    { g: 'Microsoft 365', items: [
      ms('outlook', 'Outlook', 'ph-microsoft-outlook-logo', 'Read, draft and send mail and calendar invites. Sending asks you first.'),
      ms('teams', 'Teams', 'ph-microsoft-teams-logo', 'Read chats and channels and post messages. Posting asks you first.'),
      ms('sharepoint', 'SharePoint & OneDrive', 'ph-folders', 'Search, download and upload files. Deleting or replacing asks you first.'),
      ms('excel', 'Excel', 'ph-microsoft-excel-logo', 'Workbooks download from OneDrive and are analyzed locally.'),
    ] },
    { g: 'Google Workspace', items: [
      soon('gmail', 'Gmail', 'ph-envelope-simple', 'Read and draft mail. Sending asks you first.'),
      soon('gcal', 'Calendar', 'ph-calendar-blank', 'Find time, hold slots and send invites.'),
      soon('drive', 'Drive', 'ph-google-drive-logo', 'Docs, Sheets and shared folders.'),
    ] },
    { g: 'Operations systems', items: [
      br('m3', 'M3', 'ph-browser', 'Accounting and P&L. No API, so Jarvis signs in and navigates like you do.'),
      br('toast', 'Toast', 'ph-receipt', 'Sales, menus and labor through the Toast web app.', ['API', 'Browser']),
      br('bevspot', 'BevSpot', 'ph-wine', 'Inventory counts, orders and receiving through the web app.'),
    ] },
    { g: 'Knowledge', items: [
      { id: 'memory', name: 'Memory graph', icon: 'ph-graph', desc: 'People, vendors, locations and systems Jarvis has learned.', modes: ['API'], on: true, last: 'Always on', available: true },
      br('web', 'Web research', 'ph-globe', 'Searches and reads public pages in its own browser.'),
      selfmod(),
      { id: 'analytics', name: 'Analytics', icon: 'ph-chart-bar', desc: 'DuckDB SQL over CSV, JSON, Parquet and Excel files on this PC.', modes: ['API'], on: engineOn('analytics'), last: engineOn('analytics') ? 'Ready' : 'Off', engine: 'analytics', available: true },
    ] },
  ];
}

function selfmod(): Integration {
  const on = engineOn('selfmod');
  const rel = releasePending();
  return {
    id: 'selfmod', name: 'Self-modification', icon: 'ph-wrench', engine: 'selfmod', available: true, modes: ['API'], on,
    desc: "Jarvis fixes and improves its own code in a separate workspace and test instance. You approve each update, and it goes live only when you're idle.",
    last: !on ? 'Off' : rel ? "Update ready · applies when you're idle" : 'Asks before every update',
    ...(rel ? { update: { summary: rel.summary, files: rel.files } } : {}),
  };
}

/** Handles Connect/Disconnect and preference changes from the Apps modal. */
export async function updateIntegration(id: string, patch: { on?: boolean; pref?: IntegrationPref }) {
  const item = (await integrationGroups()).flatMap(g => g.items).find(i => i.id === id);
  if (!item) throw new Error('Unknown integration ' + id);
  if (patch.pref) { prefs.pref[id] = patch.pref; save(); }
  const engine = item.engine as Engine | undefined;
  if (patch.on !== undefined && engine) {
    prefs.off = prefs.off.filter(e => e !== engine);
    if (!patch.on) prefs.off.push(engine);
    save();
    if (engine === 'browser' && !patch.on) await closeBrowser();
    if (engine === 'microsoft') {
      if (patch.on) {
        signInError = '';
        graphSignIn(c => { code = c; changed(); })
          .catch(e => { signInError = 'Sign-in failed: ' + (e as Error).message; })
          .finally(() => { code = null; changed(); });
      } else {
        await graphSignOut();
      }
    }
  }
  changed();
}

/** One-line engine status for the system prompts. */
export async function engineSummary(): Promise<string> {
  let account = '';
  try { account = (await graphAccount())?.username ?? ''; } catch { /* not configured */ }
  const ms = !engineOn('microsoft') ? 'off' : account ? `connected as ${account}` : graphConfigured() ? 'not connected (user must connect it in Apps)' : 'not configured';
  return `Microsoft 365 ${ms}; Browser ${engineOn('browser') ? 'on' : 'off'}; Analytics ${engineOn('analytics') ? 'on' : 'off'}; Self-modification ${engineOn('selfmod') ? 'on' : 'off'}.`;
}
