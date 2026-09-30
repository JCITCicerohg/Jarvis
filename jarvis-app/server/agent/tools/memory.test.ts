import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let m: typeof import('./memory.ts');

beforeAll(async () => {
  process.env.JARVIS_MEMORY_DB = join(mkdtempSync(join(tmpdir(), 'jarvis-mem-')), 'memory.db');
  m = await import('./memory.ts');
  m.memoryWrite({ entity: 'Dana Ruiz', entity_type: 'Person', fact: 'General manager at the Eastside location; reports to the user.' });
  m.memoryWrite({ entity: "Southern Glazer's", entity_type: 'Vendor', fact: 'Invoices arrive every Monday by email.' });
  m.memoryWrite({ entity: 'BevSpot', entity_type: 'System', fact: 'Inventory counts are due on the 1st of each month.' });
});

describe('keywords', () => {
  it('drops words that say nothing about what to look up', () => {
    expect(m.keywords('Who is my manager at Eastside?')).toEqual(['manager', 'eastside']);
    expect(m.keywords("What's Dana's number")).toEqual(['dana', 'number']);
  });
});

describe('retrieval', () => {
  it('ignores filler words when matching', () => {
    expect(m.memoryContext('what is it')).toBe('');
  });

  it('matches word forms (stemming)', () => {
    expect(m.memoryContext('invoice schedule')).toContain("Southern Glazer's: Invoices arrive every Monday");
  });

  it('pulls in facts about an entity named in the question', () => {
    expect(m.memoryContext('tell me about BevSpot')).toContain('Inventory counts are due on the 1st');
  });

  it('finds people by role words', () => {
    expect(m.memoryContext('who manages Eastside').split('\n')[0]).toContain('Dana Ruiz');
  });
});

describe('writing', () => {
  it('does not store the same fact twice', () => {
    expect(m.memoryWrite({ entity: 'BevSpot', fact: 'Inventory counts are due on the 1st of each month' }).added).toBe(false);
    expect(m.memoryContext('BevSpot inventory counts').match(/Inventory counts are due/g)).toHaveLength(1);
  });

  it('replaces a rule that a new one updates, instead of keeping both', () => {
    expect(m.memorySaveRule('Voice listening should end after a 3-second pause.')).toBeNull();
    expect(m.memorySaveRule('Voice listening should end only after a 5-second pause.')).toBe('Voice listening should end after a 3-second pause.');
    expect(m.rulesText()).toBe('- Voice listening should end only after a 5-second pause.');
    expect(m.memorySaveRule('Always cc Dana on vendor emails.')).toBeNull();
    expect(m.rulesText().split('\n')).toHaveLength(2);
  });

  it('remembers finished tasks for later questions', () => {
    m.rememberTask({ title: 'Collect Hilton Palacio del Rio reviews', app: 'Web', summary: 'Found 412 reviews averaging 4.3 stars; cleanliness is the top complaint.' });
    expect(m.memoryContext('what did you find about the Hilton reviews')).toContain('412 reviews');
    m.rememberTask({ title: 'Cancelled', app: 'Web', summary: 'Stopped by you.' });
    expect(m.memoryContext('cancelled')).toBe('');
  });
});
