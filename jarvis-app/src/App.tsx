import { useMemo } from 'react';
import { DesktopHome, MobileHome } from './components/Home';
import { Modal } from './components/Modal';
import { Setup } from './components/Setup';
import { Toasts, Transcript } from './components/Transcript';
import { deriveUi } from './ui';
import { useJarvis } from './useJarvis';

/**
 * Design tweakables from the prototype, exposed as URL params:
 *   ?preview=mobile  – render inside a 390px phone frame
 *   ?hud=0           – hide the HUD rings around the face
 *   ?voice=1         – start with spoken replies on
 *   ?demo=1          – the prototype's simulated tasks instead of the live agent
 */
function readOptions() {
  const q = new URLSearchParams(window.location.search);
  return {
    framed: (q.get('preview') || '').toLowerCase() === 'mobile',
    hud: q.get('hud') !== '0',
    voiceReplies: q.get('voice') === '1',
    live: q.get('demo') !== '1',
  };
}

export default function App() {
  const opts = useMemo(readOptions, []);
  const j = useJarvis(opts.voiceReplies, opts.live);
  const ui = deriveUi(j, { framed: opts.framed, hud: opts.hud });
  const { framed } = opts;

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)', color: 'var(--color-text)', fontFamily: 'var(--font-body)' }}>
      <div style={{
        position: 'relative', overflow: 'hidden',
        width: framed ? 390 : '100vw', height: framed ? 'min(844px, calc(100vh - 32px))' : '100vh',
        borderRadius: framed ? 28 : 0, boxShadow: framed ? 'var(--shadow-lg)' : 'none',
        background: 'radial-gradient(60% 60% at 50% 44%, var(--color-accent-900), var(--color-bg) 72%)',
      }}>
        {ui.isMobile ? <MobileHome ui={ui} /> : <DesktopHome ui={ui} />}
        <Toasts ui={ui} />
        {j.state.panel === 'transcript' && <Transcript ui={ui} />}
        {ui.modal && <Modal ui={ui} />}
        {j.state.setup && <Setup ui={ui} />}
      </div>
    </div>
  );
}
