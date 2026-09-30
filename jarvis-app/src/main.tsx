import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@phosphor-icons/web/regular';
import './styles/nocturne.css';
import './styles/app.css';
import App from './App';

/* Reports uncaught errors from Jarvis's own code to the server, which starts a self-repair task. */
const reported = new Set<string>();
function report(message: string, stack = '') {
  if (!message || reported.has(message) || !/\/src\//.test(stack + message)) return;
  reported.add(message);
  fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, stack }) }).catch(() => undefined);
}
window.addEventListener('error', e => report(e.message, (e.error as Error | undefined)?.stack ?? e.filename));
window.addEventListener('unhandledrejection', e => {
  const r = e.reason as Error | undefined;
  report(r?.message ?? String(e.reason), r?.stack);
});
// Tells the server the user is here, so self-modification updates wait until they're idle.
let lastPing = 0;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => {
    if (Date.now() - lastPing < 30_000) return;
    lastPing = Date.now();
    fetch('/api/activity', { method: 'POST' }).catch(() => undefined);
  }, { passive: true });
}
// Compile errors after an edit (Vite's error overlay).
import.meta.hot?.on('vite:error', p => report(p.err.message, [p.err.id, p.err.frame, p.err.stack].filter(Boolean).join('\n')));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
