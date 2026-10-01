import { describe, expect, it, vi } from 'vitest';
import { scheduleSync } from '../src/schedule.ts';

describe('scheduleSync', () => {
  it('runs once and every N minutes when minutes > 0', () => {
    const run = vi.fn();
    const timer = vi.fn();
    expect(scheduleSync(5, run, timer as unknown as typeof setInterval)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(timer).toHaveBeenCalledWith(run, 300_000);
  });
  it('does nothing when minutes is 0 (n8n triggers sync in production)', () => {
    const run = vi.fn();
    const timer = vi.fn();
    expect(scheduleSync(0, run, timer as unknown as typeof setInterval)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });
});
