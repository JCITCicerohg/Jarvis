import { describe, expect, it } from 'vitest';
import { DROPLET, doApi, ensureDroplet, ensureSshKey, publicHost, waitForIp, type DoApi } from '../scripts/do-provision.ts';

function fakeApi(state: { keys: { fingerprint: string; public_key: string; name: string }[]; droplets: any[] }) {
  const calls: { path: string; method: string; body?: any }[] = [];
  const api: DoApi = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body });
    if (path.startsWith('/v2/account/keys') && method === 'GET') return { ssh_keys: state.keys };
    if (path === '/v2/account/keys' && method === 'POST') { const k = { ...(init.body as any), fingerprint: 'fp-new' }; state.keys.push(k); return { ssh_key: k }; }
    if (path.startsWith('/v2/droplets?tag_name=') && method === 'GET') return { droplets: state.droplets };
    if (path === '/v2/droplets' && method === 'POST') { const d = { id: 42, networks: { v4: [] } }; state.droplets.push(d); return { droplet: d }; }
    if (path === '/v2/droplets/42') return { droplet: state.droplets[0] };
    throw new Error('unexpected ' + method + ' ' + path);
  };
  return { api, calls };
}

describe('do-provision', () => {
  it('reuses an existing SSH key with the same public key', async () => {
    const { api, calls } = fakeApi({ keys: [{ name: 'x', public_key: 'ssh-ed25519 AAA me', fingerprint: 'fp-old' }], droplets: [] });
    expect(await ensureSshKey(api, 'jarvis-kb', 'ssh-ed25519 AAA me\n')).toBe('fp-old');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('uploads the key when missing', async () => {
    const { api, calls } = fakeApi({ keys: [], droplets: [] });
    expect(await ensureSshKey(api, 'jarvis-kb', 'ssh-ed25519 BBB me')).toBe('fp-new');
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ name: 'jarvis-kb', public_key: 'ssh-ed25519 BBB me' });
  });

  it('creates the droplet once, then finds it by tag', async () => {
    const state = { keys: [], droplets: [] as any[] };
    const { api, calls } = fakeApi(state);
    const spec = { ...DROPLET, ssh_keys: ['fp'], user_data: '#cloud-config' };
    expect(await ensureDroplet(api, spec)).toEqual({ id: 42, created: true });
    expect(calls.find(c => c.method === 'POST')!.body).toMatchObject({ name: 'jarvis-kb', region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64', tags: ['jarvis-kb'] });
    expect(await ensureDroplet(api, spec)).toEqual({ id: 42, created: false });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it('waits for the public IPv4', async () => {
    const state = { keys: [], droplets: [{ id: 42, networks: { v4: [] as any[] } }] };
    const { api } = fakeApi(state);
    setTimeout(() => { state.droplets[0].networks.v4 = [{ type: 'private', ip_address: '10.0.0.2' }, { type: 'public', ip_address: '1.2.3.4' }]; }, 20);
    expect(await waitForIp(api, 42, { intervalMs: 5, timeoutMs: 1000 })).toBe('1.2.3.4');
  });

  it('sends the bearer token and reports API errors without the token', async () => {
    let auth = '';
    const ok = (async (_u: string, init: { headers: Record<string, string> }) => { auth = init.headers.Authorization; return Response.json({ ok: 1 }); }) as unknown as typeof fetch;
    await doApi('tok-123', ok)('/v2/account');
    expect(auth).toBe('Bearer tok-123');
    const bad = (async () => new Response('{"message":"Unable to authenticate you"}', { status: 401 })) as unknown as typeof fetch;
    await expect(doApi('tok-123', bad)('/v2/account')).rejects.toThrow(/DigitalOcean 401: Unable to authenticate you/);
    await expect(doApi('tok-123', bad)('/v2/account')).rejects.not.toThrow(/tok-123/);
  });

  it('builds the sslip.io host', () => {
    expect(publicHost('164.90.1.2')).toBe('164-90-1-2.sslip.io');
  });
});
