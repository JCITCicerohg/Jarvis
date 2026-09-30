import { useEffect, useRef } from 'react';
import { SUGGESTIONS, TOAST_ICON } from '../data';
import type { Ui } from '../ui';
import { Options, ThoughtLine } from './Ask';
import { Orb } from './Orb';

export function Transcript({ ui }: { ui: Ui }) {
  const { s, j } = ui;
  const msgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = msgRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, s.busy, s.chatThought, s.chatReply]);

  return (
    <aside style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: ui.isMobile ? '100%' : 400, zIndex: 20, display: 'flex', flexDirection: 'column', background: 'var(--color-surface)', boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'var(--space-4) var(--space-4) var(--space-4) var(--space-6)' }}>
        <Orb size={22} state={s.orb} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Transcript</div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>{ui.orbLabel}</div>
        </div>
        <button className="btn btn-icon btn-secondary" onClick={() => j.set({ messages: [] })} disabled={!s.messages.length || s.busy} title="New conversation"><i className="ph ph-note-pencil" style={{ fontSize: 17 }} /></button>
        <button className="btn btn-icon btn-secondary" onClick={j.toggleSpeak} title="Speak replies aloud"><i className={'ph ' + ui.speakIcon} style={{ fontSize: 17 }} /></button>
        <button className="btn btn-icon btn-secondary" onClick={ui.closePanel} title="Close"><i className="ph ph-x" style={{ fontSize: 17 }} /></button>
      </div>

      <div ref={msgRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-4) var(--space-6)' }}>
        {!s.messages.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ fontSize: 14, color: 'var(--color-neutral-300)' }}>Talk or type. Hand me work and I'll run it in the background, then check back with you before anything is sent, paid or deleted.</div>
            {SUGGESTIONS.map(q => (
              <button key={q} className="btn btn-secondary" onClick={() => j.send(q)} style={{ justifyContent: 'flex-start', textAlign: 'left', fontSize: 13, lineHeight: 1.35 }}>{q}</button>
            ))}
          </div>
        )}
        {s.messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent-900)', boxShadow: '0 0 0 1px var(--color-accent-800)', fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.text}</div>
          ) : m.role === 'assistant' ? (
            <div key={i} style={{ maxWidth: '92%', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {i === s.messages.length - 1 && <Options options={ui.chatOptions} onPick={o => j.send(o)} />}
            </div>
          ) : (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--color-accent-300)' }}><i className={'ph ' + m.icon} />{m.text}</div>
          ),
        )}
        {s.busy && s.chatReply && <div style={{ maxWidth: '92%', fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--color-neutral-300)' }}>{s.chatReply}</div>}
        {s.busy && !s.chatReply && (s.chatThought ? <ThoughtLine text={s.chatThought} live clamp={6} size={13} /> : <div style={{ fontSize: 13, color: 'var(--color-neutral-500)' }}>Thinking…</div>)}
      </div>

      <div style={{ padding: 'var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, padding: 6, borderRadius: 'var(--radius-md)', background: 'var(--color-bg)', boxShadow: 'var(--shadow-sm)' }}>
          <textarea rows={2} value={s.input} onChange={ui.onInput} onKeyDown={ui.onKey} placeholder={ui.placeholder}
            style={{ flex: 1, resize: 'none', background: 'transparent', border: 0, outline: 'none', color: 'var(--color-text)', font: 'inherit', fontSize: 14, padding: 6 }} />
          <button className="btn btn-icon btn-secondary" onClick={j.toggleMic} title="Speak"><i className={'ph ' + ui.micIcon} style={{ fontSize: 17 }} /></button>
          <button className="btn btn-icon btn-primary" onClick={() => j.send()} disabled={ui.cantSend} title="Send"><i className="ph ph-paper-plane-right" style={{ fontSize: 17 }} /></button>
        </div>
      </div>
    </aside>
  );
}

export function Toasts({ ui }: { ui: Ui }) {
  const { set } = ui.j;
  return (
    <div style={{ position: 'absolute', top: ui.isMobile ? 76 : 84, left: '50%', transform: 'translateX(-50%)', width: 'min(360px, calc(100% - 32px))', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 25, pointerEvents: 'none' }}>
      {ui.s.toasts.map(x => (
        <div key={x.id} style={{ pointerEvents: 'auto', display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)', backdropFilter: 'blur(12px)', boxShadow: 'var(--shadow-md)' }}>
          <i className={'ph ' + TOAST_ICON[x.kind]} style={{ fontSize: 18, color: 'var(--color-accent-400)', marginTop: 1 }} />
          <button className="bare-btn" onClick={() => ui.openTask(x.task)} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: 0, textAlign: 'left' }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{x.title}</span>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-400)' }}>{x.text}</span>
          </button>
          <button className="bare-btn" onClick={() => set(st => ({ toasts: st.toasts.filter(y => y.id !== x.id) }))} title="Dismiss" style={{ color: 'var(--color-neutral-500)', padding: 2 }}>
            <i className="ph ph-x" />
          </button>
        </div>
      ))}
    </div>
  );
}
