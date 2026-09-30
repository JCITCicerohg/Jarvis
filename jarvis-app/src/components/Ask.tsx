import { useState, type FormEvent } from 'react';
import type { Ui } from '../ui';

/** Tap-to-answer suggestions under a question (chat or task). */
export function Options({ options, onPick, disabled }: { options: string[]; onPick: (o: string) => void; disabled?: boolean }) {
  if (!options.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(o => (
        <button key={o} className="btn btn-secondary" disabled={disabled} onClick={() => onPick(o)} style={{ fontSize: 13, padding: '5px 12px', minHeight: 32 }}>{o}</button>
      ))}
    </div>
  );
}

/** A running task's clarifying question: suggested answers plus a free-text answer. */
export function QuestionBox({ ui, id, question, why, options, compact }: { ui: Ui; id: string; question: string; why?: string; options: string[]; compact?: boolean }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) { ui.j.answer(id, text); setText(''); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ fontSize: compact ? 14 : 16, fontWeight: 500, lineHeight: 1.35, textWrap: 'pretty' } as React.CSSProperties}>{question}</div>
      {why && <div style={{ fontSize: 12, color: 'var(--color-neutral-400)' }}>{why}</div>}
      <Options options={options} onPick={o => ui.j.answer(id, o)} />
      <form onSubmit={submit} style={{ display: 'flex', gap: 6 }}>
        <input className="input" value={text} onChange={e => setText(e.target.value)} placeholder={options.length ? 'Or type your answer…' : 'Type your answer…'} aria-label="Your answer" style={{ minHeight: 32, fontSize: 13 }} />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()} style={{ fontSize: 13, padding: '4px 12px' }}><i className="ph ph-paper-plane-right" />Answer</button>
      </form>
    </div>
  );
}

/** One line of Jarvis's thinking; pulses while it is still streaming in. */
export function ThoughtLine({ text, live, clamp = 2, size = 12 }: { text: string; live?: boolean; clamp?: number; size?: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: size, lineHeight: 1.45, color: 'var(--color-accent-200)', minWidth: 0 }}>
      <i className={'ph ph-brain' + (live ? ' thinking-pulse' : '')} style={{ marginTop: 2, flex: 'none', color: 'var(--color-accent-400)' }} />
      <span style={{ fontStyle: 'italic', display: '-webkit-box', WebkitLineClamp: clamp, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>{text}</span>
    </div>
  );
}

/** Every thought on a task, oldest first, with the live one last. */
export function ThoughtList({ thoughts }: { thoughts: { text: string; time: string; live?: boolean }[] }) {
  if (!thoughts.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4) var(--space-6)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', boxShadow: 'var(--shadow-sm)' }}>
      <h6 style={{ margin: 0, color: 'var(--color-neutral-400)', display: 'flex', alignItems: 'center', gap: 6 }}><i className="ph ph-brain" />Jarvis's thinking</h6>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflow: 'auto' }}>
        {thoughts.map((x, k) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'start' }}>
            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: x.live ? 'var(--color-accent-200)' : 'var(--color-neutral-300)' }}>
              {x.live && <i className="ph ph-brain thinking-pulse" style={{ marginRight: 6, color: 'var(--color-accent-400)' }} />}{x.text}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', paddingTop: 2 }}>{x.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
