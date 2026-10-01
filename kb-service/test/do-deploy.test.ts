import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKbEnv, loadSecrets, parseEnv, remoteScript } from '../scripts/do-deploy.ts';

describe('do-deploy helpers', () => {
  it('parses env files, ignoring comments and blank lines, keeping = inside values', () => {
    const m = parseEnv('# c\nA=1\n\nB=x=y\nC=\n');
    expect([...m.entries()]).toEqual([['A', '1'], ['B', 'x=y'], ['C', '']]);
  });

  it('builds kb.env: drops local-only keys and adds the n8n key', () => {
    const src = parseEnv('DATABASE_URL=postgres://local\nPORT=8790\nBLOB_DIR=data/blobs\nSYNC_MINUTES=5\nKB_API_KEYS=owner:abc\nANTHROPIC_API_KEY=sk-ant\nKB_EMBED_PROVIDER=local\nKB_MS_CLIENT_ID=cid\n');
    const out = parseEnv(buildKbEnv(src, 'n8nkey', 'abc1234'));
    expect(out.get('KB_API_KEYS')).toBe('owner:abc,n8n:n8nkey');
    expect(out.has('DATABASE_URL') || out.has('PORT') || out.has('BLOB_DIR') || out.has('SYNC_MINUTES')).toBe(false);
    expect(out.get('ANTHROPIC_API_KEY')).toBe('sk-ant');
    expect(out.get('KB_MS_CLIENT_ID')).toBe('cid');
    expect(out.get('KB_CONFIG_VERSION')).toBe('abc1234');
  });

  it('does not duplicate the n8n key on a second deploy', () => {
    const out = parseEnv(buildKbEnv(parseEnv('KB_API_KEYS=owner:abc,n8n:n8nkey\n'), 'n8nkey'));
    expect(out.get('KB_API_KEYS')).toBe('owner:abc,n8n:n8nkey');
  });

  it('creates secrets once and reuses them', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kb-sec-')), '.secrets.json');
    let n = 0;
    const gen = () => `s${++n}`;
    const a = loadSecrets(p, gen);
    const b = loadSecrets(p, gen);
    expect(a).toEqual({ postgresPassword: 's1', n8nKey: 's2', queryDbPassword: 's3' });
    expect(b).toEqual(a);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(a);
  });

  it('backfills queryDbPassword in an old secrets file', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kb-sec-')), '.secrets.json');
    writeFileSync(p, JSON.stringify({ postgresPassword: 'pg1', n8nKey: 'n8n1' }, null, 2), { mode: 0o600 });
    let n = 0;
    const gen = () => `new${++n}`;
    const result = loadSecrets(p, gen);
    expect(result).toEqual({ postgresPassword: 'pg1', n8nKey: 'n8n1', queryDbPassword: 'new1' });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(result);
  });

  it('buildKbEnv sets KB_QUERY_DB_PASSWORD when provided', () => {
    const src = parseEnv('KB_API_KEYS=owner:abc\n');
    const out = parseEnv(buildKbEnv(src, 'n8nkey', 'v1', 'querypass'));
    expect(out.get('KB_QUERY_DB_PASSWORD')).toBe('querypass');
  });

  it('remote script unpacks, protects env files and rebuilds without touching volumes', () => {
    const s = remoteScript();
    expect(s).toContain('tar xzf release.tgz');
    expect(s).toContain('chmod 600 deploy/.env deploy/kb.env');
    expect(s).toContain('docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build');
    expect(s).not.toMatch(/down -v|volume rm/);
    expect(s).toContain(`SELECT 1 FROM pg_database WHERE datname='kb_test'`);
    expect(s).toContain('createdb -U kb kb_test');
    expect(s).toContain('grep -q "^KB_TEST_ENABLED=1" deploy/.env');
    expect(s).toContain('--profile test up -d --build kb-test');
    expect(s.indexOf('up -d --build')).toBeLessThan(s.indexOf('createdb -U kb kb_test'));
  });
});
