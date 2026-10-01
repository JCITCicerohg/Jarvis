/** Starts the periodic sync when minutes > 0; production sets 0 and lets n8n call POST /v1/sync. */
export function scheduleSync(minutes: number, run: () => void, setIntervalImpl: typeof setInterval = setInterval): boolean {
  if (!(minutes > 0)) return false;
  run();
  setIntervalImpl(run, minutes * 60_000);
  return true;
}
