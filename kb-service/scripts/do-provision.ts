import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type DoApi = (path: string, init?: { method?: string; body?: unknown }) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface DropletSpec { name: string; region: string; size: string; image: string; tags: string[]; ssh_keys?: string[]; user_data?: string }

export const DROPLET: DropletSpec = { name: 'jarvis-kb', region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64', tags: ['jarvis-kb'] };
export const publicHost = (ip: string) => `${ip.replace(/\./g, '-')}.sslip.io`;

export function doApi(token: string, fetchImpl: typeof fetch = fetch): DoApi {
  return async (path, init = {}) => {
    const res = await fetchImpl('https://api.digitalocean.com' + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = (JSON.parse(text) as { message?: string }).message ?? msg; } catch { /* not JSON */ }
      throw new Error(`DigitalOcean ${res.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  };
}

const norm = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ');

export async function ensureSshKey(api: DoApi, name: string, publicKey: string): Promise<string> {
  const { ssh_keys } = await api('/v2/account/keys?per_page=200');
  const found = (ssh_keys as { public_key: string; fingerprint: string }[]).find(k => norm(k.public_key) === norm(publicKey));
  if (found) return found.fingerprint;
  const { ssh_key } = await api('/v2/account/keys', { method: 'POST', body: { name, public_key: publicKey.trim() } });
  return ssh_key.fingerprint;
}

export async function ensureDroplet(api: DoApi, spec: DropletSpec): Promise<{ id: number; created: boolean }> {
  const { droplets } = await api(`/v2/droplets?tag_name=${encodeURIComponent(spec.tags[0])}`);
  if (droplets.length) return { id: droplets[0].id, created: false };
  const { droplet } = await api('/v2/droplets', { method: 'POST', body: spec });
  return { id: droplet.id, created: true };
}

export async function waitForIp(api: DoApi, id: number, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<string> {
  const until = Date.now() + (opts.timeoutMs ?? 300_000);
  while (Date.now() < until) {
    const { droplet } = await api(`/v2/droplets/${id}`);
    const ip = (droplet.networks?.v4 ?? []).find((n: { type: string }) => n.type === 'public')?.ip_address;
    if (ip) return ip;
    await new Promise(r => setTimeout(r, opts.intervalMs ?? 5000));
  }
  throw new Error(`Droplet ${id} has no public IP after waiting`);
}

if (process.argv[1]?.endsWith('do-provision.ts')) {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (!token) throw new Error('Set DIGITALOCEAN_TOKEN (a Read + Write API token) in the environment.');
  const keyPath = join(homedir(), '.ssh', 'jarvis_do');
  if (!existsSync(keyPath + '.pub')) execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'jarvis-kb', '-f', keyPath], { stdio: 'inherit' });
  const api = doApi(token);
  const fingerprint = await ensureSshKey(api, 'jarvis-kb', readFileSync(keyPath + '.pub', 'utf8'));
  const repo = resolve(import.meta.dirname, '..', '..');
  const userData = readFileSync(join(repo, 'deploy', 'cloud-init.yaml'), 'utf8');
  const { id, created } = await ensureDroplet(api, { ...DROPLET, ssh_keys: [fingerprint], user_data: userData });
  const ip = await waitForIp(api, id);
  writeFileSync(join(repo, 'deploy', '.droplet.json'), JSON.stringify({ id, ip, host: publicHost(ip) }, null, 2));
  console.log(`${created ? 'Created' : 'Found'} droplet ${DROPLET.name} (${id}) at ${ip} → https://kb.${publicHost(ip)}`);
}
