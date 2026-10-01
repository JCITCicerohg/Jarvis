import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wf = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'deploy', 'n8n', 'kb-sync.json'), 'utf8'));

describe('n8n kb-sync workflow', () => {
  it('has a fixed id (import is idempotent), a 5-minute schedule and a sync call', () => {
    expect(wf.id).toBe('kbsync5min0001');
    const trigger = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.scheduleTrigger');
    expect(trigger.parameters.rule.interval[0]).toEqual({ field: 'minutes', minutesInterval: 5 });
    const http = wf.nodes.find((n: { type: string }) => n.type === 'n8n-nodes-base.httpRequest');
    expect(http.parameters).toMatchObject({ method: 'POST', url: 'http://kb:8790/v1/sync' });
    expect(JSON.stringify(http.parameters)).toContain('$env.KB_N8N_KEY');
    expect(wf.connections[trigger.name].main[0][0].node).toBe(http.name);
  });
  it('contains no secrets', () => {
    expect(JSON.stringify(wf)).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
  });
});
