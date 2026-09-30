import type { Ui } from '../ui';
import type { TaskVm } from '../view';
import { Options, QuestionBox, ThoughtLine } from './Ask';
import { JarvisFace } from './JarvisFace';

function RunCard({ t, ui, mobile }: { t: TaskVm; ui: Ui; mobile?: boolean }) {
  return (
    <button className={'run-card' + (mobile ? ' mobile' : '')} onClick={() => ui.openTask(t.id)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className={'ph ' + t.modeIcon} style={{ color: 'var(--color-accent-400)' }} />
        <span style={{ flex: 1, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-neutral-400)' }}>{t.app}</span>
        {t.hasFix && <i className="ph ph-wrench" style={{ color: 'var(--color-accent-300)' }} />}
      </div>
      <div style={{ fontSize: mobile ? 14 : 13, fontWeight: 500, lineHeight: 1.3 }}>{t.title}</div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-500)', ...(mobile ? {} : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}>{t.current}</div>
      {t.thought && <ThoughtLine text={t.thought} live={t.thinking} />}
      <div className="progress"><div style={{ width: t.progress }} /></div>
    </button>
  );
}

function DecisionCard({ a, ui, mobile }: { a: TaskVm; ui: Ui; mobile?: boolean }) {
  const btn = mobile ? { minHeight: 40 } : { padding: '4px 10px', fontSize: 13 };
  if (a.isQuestion) return (
    <div className={'decision-card' + (mobile ? ' mobile' : '')}>
      <div className="card-kicker">Question · {a.title}</div>
      <QuestionBox ui={ui} id={a.id} question={a.question!} why={a.why} options={a.options} compact />
      <button className="btn btn-ghost" onClick={() => ui.openTask(a.id)} style={{ alignSelf: 'flex-end', ...(mobile ? { minHeight: 40 } : { fontSize: 12 }) }}>Details</button>
    </div>
  );
  return (
    <div className={'decision-card' + (mobile ? ' mobile' : '')}>
      <div className="card-kicker">{a.risk} · {a.app}</div>
      <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{a.action}</div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-400)' }}>{a.detail}</div>
      {a.preview && <pre className="approval-preview">{a.preview}</pre>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: mobile ? undefined : 'wrap' }}>
        <button className="btn btn-primary" onClick={() => ui.j.decide(a.id, true)} style={btn}><i className="ph ph-check" />Approve</button>
        <button className="btn btn-secondary" onClick={() => ui.j.decide(a.id, false)} style={btn}>Decline</button>
        <button className="btn btn-ghost" onClick={() => ui.openTask(a.id)} style={{ marginLeft: 'auto', ...(mobile ? { minHeight: 40 } : { fontSize: 12 }) }}>Details</button>
      </div>
    </div>
  );
}

function Composer({ ui, mobile }: { ui: Ui; mobile?: boolean }) {
  const { s, j } = ui;
  return (
    <div style={{
      width: mobile ? undefined : '100%', flex: mobile ? 1 : undefined, display: 'flex', alignItems: 'center', gap: 8, padding: 6,
      borderRadius: 'var(--radius-lg)', background: `color-mix(in srgb, var(--color-surface) ${mobile ? 85 : 78}%, transparent)`,
      backdropFilter: mobile ? undefined : 'blur(14px)', boxShadow: 'var(--shadow-md)',
    }}>
      <button className="mic-btn" onClick={j.toggleMic} title="Talk to Jarvis" style={{ background: ui.micBg, boxShadow: ui.micGlow }}>
        <i className={'ph ' + ui.micIcon} style={{ fontSize: 20 }} />
      </button>
      <input className="composer-input" value={s.input} onChange={ui.onInput} onKeyDown={ui.onKey} placeholder={ui.placeholder} />
      <button className="btn btn-icon btn-primary" onClick={() => j.send()} disabled={ui.cantSend} title="Send" style={mobile ? { width: 44, height: 44 } : undefined}>
        <i className="ph ph-paper-plane-right" style={{ fontSize: 17 }} />
      </button>
    </div>
  );
}

/** What Jarvis is thinking about the main task right now. Opens the task. */
function FocusLine({ ui }: { ui: Ui }) {
  const f = ui.focus!;
  return (
    <button className="bare-btn" onClick={() => ui.openTask(f.id)} title="Open this task" style={{ maxWidth: 560, width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'color-mix(in srgb, var(--color-accent-900) 70%, transparent)', boxShadow: '0 0 0 1px var(--color-accent-800)', textAlign: 'left' }}>
      <span style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--color-accent-300)' }}>Working on · {f.title}</span>
      <ThoughtLine text={f.text} live={f.live} clamp={3} size={13} />
    </button>
  );
}

export function DesktopHome({ ui }: { ui: Ui }) {
  const { s, j } = ui;
  return (
    <>
      <div style={{ position: 'absolute', left: '50%', top: '44%', transform: 'translate(-50%,-50%)', width: ui.faceSize, height: ui.faceSize }}>
        <JarvisFace state={ui.faceState} hud={ui.hud} label={false} />
      </div>

      <div style={{ position: 'absolute', top: 28, left: 32, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 11, letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--color-accent-300)' }}>Jarvis</div>
        <div style={{ fontSize: 34, fontWeight: 500, letterSpacing: '-.02em', lineHeight: 1.1 }}>{ui.clock}</div>
        <div style={{ fontSize: 13, color: 'var(--color-neutral-400)' }}>{ui.dateLine}</div>
      </div>

      <div style={{ position: 'absolute', top: 28, right: 32, display: 'flex', gap: 8 }}>
        {ui.fabs.map(f => (
          <button key={f.id} className="glass-btn" onClick={f.go}>
            <i className={'ph ' + f.icon} style={{ fontSize: 18 }} />{f.label}
            {!!f.badge && <span className="tag tag-accent" style={{ padding: '1px 7px' }}>{f.badge}</span>}
          </button>
        ))}
      </div>

      <div className="rail" style={{ left: 32, width: ui.railW }}>
        <h6 style={{ margin: '0 0 4px 2px', color: 'var(--color-neutral-400)' }}>Running · {ui.running.length}</h6>
        {ui.running.map(t => <RunCard key={t.id} t={t} ui={ui} />)}
        {ui.doneCount > 0 && (
          <button className="btn btn-ghost" onClick={ui.openTasks} style={{ alignSelf: 'flex-start', fontSize: 12 }}>
            <i className="ph ph-check-circle" />{ui.doneCount} done today
          </button>
        )}
      </div>

      <div className="rail" style={{ right: 32, width: ui.railW }}>
        <h6 style={{ margin: '0 0 4px 2px', color: 'var(--color-accent-300)' }}>Needs you · {ui.waiting.length}</h6>
        {ui.waiting.map(a => <DecisionCard key={a.id} a={a} ui={ui} />)}
        {!ui.waiting.length && <div style={{ fontSize: 13, color: 'var(--color-neutral-500)', paddingLeft: 2 }}>Nothing needs you right now.</div>}
      </div>

      <div style={{ position: 'absolute', left: 32, bottom: 28, display: 'flex', gap: 8 }}>
        <button className="glass-btn" onClick={ui.openTranscript}>
          <i className="ph ph-chat-circle-text" style={{ fontSize: 18 }} />Transcript
          {s.messages.length > 0 && <span className="tag tag-neutral" style={{ padding: '1px 7px' }}>{ui.msgCount}</span>}
        </button>
      </div>
      <div style={{ position: 'absolute', right: 32, bottom: 28, display: 'flex', gap: 8 }}>
        <button className="glass-btn" onClick={j.toggleSpeak}><i className={'ph ' + ui.speakIcon} style={{ fontSize: 18 }} />{ui.speakLabel}</button>
      </div>

      <div style={{ position: 'absolute', left: '50%', bottom: 28, transform: 'translateX(-50%)', width: 'min(560px, calc(100% - 440px))', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        {ui.focus && <FocusLine ui={ui} />}
        <div style={{ maxWidth: 560, textAlign: 'center', fontSize: 17, lineHeight: 1.45, color: s.busy && !s.chatReply && s.chatThought ? 'var(--color-accent-200)' : 'var(--color-neutral-200)', fontStyle: s.busy && !s.chatReply && s.chatThought ? 'italic' : undefined, textWrap: 'pretty', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
          {ui.caption}
        </div>
        {ui.chatOptions.length > 0 && <div style={{ display: 'flex', justifyContent: 'center' }}><Options options={ui.chatOptions} onPick={o => j.send(o)} /></div>}
        {s.panel !== 'transcript' && <Composer ui={ui} />}
      </div>
    </>
  );
}

export function MobileHome({ ui }: { ui: Ui }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 10, letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--color-accent-300)' }}>Jarvis</div>
          <div style={{ fontSize: 22, fontWeight: 500, lineHeight: 1.1 }}>{ui.clock}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {ui.fabs.map(f => (
            <button key={f.id} className="glass-sq" onClick={f.go} title={f.label}>
              <i className={'ph ' + f.icon} style={{ fontSize: 19 }} />
              {!!f.badge && (
                <span style={{ position: 'absolute', top: 4, right: 4, minWidth: 15, height: 15, padding: '0 4px', borderRadius: 8, background: 'var(--color-accent)', color: 'var(--color-bg)', fontSize: 10, display: 'grid', placeItems: 'center' }}>{f.badge}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: '0 16px 16px' }}>
        <div style={{ width: '100%', height: 280, flex: 'none' }}><JarvisFace state={ui.faceState} hud={ui.hud} label={false} /></div>
        <div style={{ textAlign: 'center', fontSize: 16, lineHeight: 1.45, color: 'var(--color-neutral-200)', textWrap: 'pretty', marginTop: -8 } as React.CSSProperties}>{ui.caption}</div>
        {ui.chatOptions.length > 0 && <div style={{ display: 'flex', justifyContent: 'center' }}><Options options={ui.chatOptions} onPick={o => ui.j.send(o)} /></div>}
        {ui.focus && <FocusLine ui={ui} />}
        {ui.waiting.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h6 style={{ margin: 0, color: 'var(--color-accent-300)' }}>Needs you · {ui.waiting.length}</h6>
            {ui.waiting.map(a => <DecisionCard key={a.id} a={a} ui={ui} mobile />)}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h6 style={{ margin: 0, color: 'var(--color-neutral-400)' }}>Running · {ui.running.length}</h6>
          {ui.running.map(t => <RunCard key={t.id} t={t} ui={ui} mobile />)}
          {ui.doneCount > 0 && (
            <button className="btn btn-ghost" onClick={ui.openTasks} style={{ alignSelf: 'flex-start', minHeight: 44 }}>
              <i className="ph ph-check-circle" />{ui.doneCount} done today
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: '10px 16px 20px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <Composer ui={ui} mobile />
        <button className="glass-sq" onClick={ui.openTranscript} title="Transcript" style={{ backdropFilter: 'none' }}>
          <i className="ph ph-chat-circle-text" style={{ fontSize: 19 }} />
        </button>
      </div>
    </div>
  );
}
