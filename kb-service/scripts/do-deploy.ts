import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LOCAL_ONLY = ['DATABASE_URL', 'PORT', 'BLOB_DIR', 'SYNC_MINUTES', 'HF_CACHE_DIR'];
const randomHex = () => randomBytes(24).toString('hex');

export function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}

export function buildKbEnv(src: Map<string, string>, n8nKey: string, configVersion?: string): string {
  const out = new Map([...src].filter(([k]) => !LOCAL_ONLY.includes(k)));
  const keys = (out.get('KB_API_KEYS') ?? '').split(',').map(s => s.trim()).filter(s => s && !s.startsWith('n8n:'));
  out.set('KB_API_KEYS', [...keys, `n8n:${n8nKey}`].join(','));
  if (!['openai', 'azure'].includes(out.get('KB_EMBED_PROVIDER') ?? '')) out.set('KB_EMBED_PROVIDER', 'local');
  if (configVersion) out.set('KB_CONFIG_VERSION', configVersion);
  return [...out].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export function loadSecrets(path: string, gen: () => string = randomHex): { postgresPassword: string; n8nKey: string } {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const s = { postgresPassword: gen(), n8nKey: gen() };
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

export function remoteScript(): string {
  return [
    'set -euo pipefail',
    'while [ ! -f /opt/jarvis-kb/.cloud-init-done ]; do echo "waiting for first-boot setup…"; sleep 10; done',
    'cd /opt/jarvis-kb',
    'tar xzf release.tgz && rm release.tgz',
    'mv -f kb.env deploy/kb.env && mv -f dot-env deploy/.env',
    'chmod 600 deploy/.env deploy/kb.env',
    'dc="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"',
    '$dc exec -T db psql -U kb -tAc "SELECT 1 FROM pg_database WHERE datname=\'kb_test\'" | grep -q 1 || $dc exec -T db createdb -U kb kb_test',
    'docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build',
    'if grep -q "^KB_TEST_ENABLED=1" deploy/.env; then docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile test up -d --build kb-test; fi',
    'bash deploy/n8n-setup.sh',
  ].join('\n');
}

async function waitForHealth(url: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error(`${url} did not answer within ${Math.round(timeoutMs / 60_000)} minutes. Check: ssh root@<ip> "cd /opt/jarvis-kb && docker compose -f deploy/docker-compose.yml logs --tail 100"`);
}

if (process.argv[1]?.endsWith('do-deploy.ts')) {
  const repo = resolve(import.meta.dirname, '..', '..');
  const dropletFile = join(repo, 'deploy', '.droplet.json');
  if (!existsSync(dropletFile)) throw new Error('No deploy/.droplet.json; run npm run do:provision first.');
  const { ip, host } = JSON.parse(readFileSync(dropletFile, 'utf8')) as { ip: string; host: string };
  const secrets = loadSecrets(join(repo, 'deploy', '.secrets.json'));
  const work = mkdtempSync(join(tmpdir(), 'kb-deploy-'));
  const version = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).toString().trim();
  writeFileSync(join(work, 'kb.env'), buildKbEnv(parseEnv(readFileSync(join(repo, 'kb-service', '.env'), 'utf8')), secrets.n8nKey, version), { mode: 0o600 });
  writeFileSync(join(work, 'dot-env'), `POSTGRES_PASSWORD=${secrets.postgresPassword}\nPUBLIC_HOST=${host}\nKB_N8N_KEY=${secrets.n8nKey}\n`, { mode: 0o600 });
  execFileSync('git', ['-C', repo, 'archive', '--format=tar.gz', '-o', join(work, 'release.tgz'), 'HEAD', 'kb-service', 'deploy'], { stdio: 'inherit' });
  const ssh = ['-i', join(homedir(), '.ssh', 'jarvis_do'), '-o', 'StrictHostKeyChecking=accept-new'];
  execFileSync('ssh', [...ssh, `root@${ip}`, 'mkdir -p /opt/jarvis-kb'], { stdio: 'inherit' });
  execFileSync('scp', [...ssh, join(work, 'release.tgz'), join(work, 'kb.env'), join(work, 'dot-env'), `root@${ip}:/opt/jarvis-kb/`], { stdio: 'inherit' });
  execFileSync('ssh', [...ssh, `root@${ip}`, remoteScript()], { stdio: 'inherit' });
  await waitForHealth(`https://kb.${host}/health`, 15 * 60_000);
  console.log(`Deployed. API: https://kb.${host}  ·  n8n: https://n8n.${host}`);
}
