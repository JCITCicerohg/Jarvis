import { useEffect, useState } from 'react';
import { MODALS, TYPE_FILL } from '../data';
import type { IntegrationPref, MemMode, MemNode, Task } from '../types';
import type { Ui } from '../ui';
import { SILENCE_MAX, SILENCE_MIN } from '../useJarvis';
import { taskDetail } from '../view';
import { QuestionBox, ThoughtLine, ThoughtList } from './Ask';
import { Orb } from './Orb';

function TaskPanel({ ui, t }: { ui: Ui; t: Task }) {
  const d = taskDetail(t);
  const { j, set } = { j: ui.j, set: ui.j.set };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="tag tag-accent">{d.statusLabel}</span>
          <span className="tag tag-neutral">{d.app}</span>
          <span className="tag tag-outline" style={{ gap: 5 }}><i className={'ph ' + d.modeIcon} />{d.mode}</span>
        </div>
        <h3 style={{ margin: 0, textWrap: 'pretty' } as React.CSSProperties}>{d.title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--color-neutral-500)' }}>
          <div style={{ flex: 1, maxWidth: 360, height: 3, borderRadius: 2, background: 'var(--color-neutral-800)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: d.progress, background: 'var(--color-accent)', transition: 'width .6s' }} />
          </div>
          {d.progress}
        </div>
      </div>

      {d.isQuestion && (
        <div className="card glow-card" style={{ gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
          <div className="card-kicker">Jarvis has a question</div>
          <QuestionBox ui={ui} id={t.id} question={d.question!} why={d.why} options={d.options} />
        </div>
      )}

      {d.isWaiting && !d.isQuestion && (
        <div className="card glow-card" style={{ gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
          <div className="card-kicker">Jarvis is waiting on you · {d.risk}</div>
          <div className="card-title">{d.action}</div>
          <div style={{ fontSize: 13, color: 'var(--color-neutral-400)' }}>{d.detail}</div>
          {d.preview && <pre className="approval-preview">{d.preview}</pre>}
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn btn-primary" onClick={() => j.decide(t.id, true)}><i className="ph ph-check" />Approve</button>
            <button className="btn btn-secondary" onClick={() => j.decide(t.id, false)}>Decline</button>
          </div>
        </div>
      )}

      {d.report && (
        <div className="card elev-sm" style={{ gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
          <div className="card-kicker">Report</div>
          <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{d.report.summary}</div>
          {d.report.nextSteps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>Recommended next</div>
              {d.report.nextSteps.map(n => (
                <div key={n} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--color-neutral-300)' }}>
                  <i className="ph ph-arrow-right" style={{ marginTop: 3, color: 'var(--color-accent)' }} /><span>{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {d.hasFix && (
        <div style={{ display: 'flex', gap: 'var(--space-4)', padding: 'var(--space-4) var(--space-6)', borderRadius: 'var(--radius-md)', background: 'var(--color-accent-900)', boxShadow: '0 0 0 1px var(--color-accent-800)' }}>
          <i className="ph ph-wrench" style={{ fontSize: 20, color: 'var(--color-accent-400)', marginTop: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Jarvis fixed itself · {d.fixTime}</div>
            <div style={{ fontSize: 13, color: 'var(--color-neutral-300)' }}>{d.fixText}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(300px,100%),1fr))', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--color-surface)', boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--color-neutral-900)', fontSize: 12, color: 'var(--color-neutral-400)' }}>
            <i className={'ph ' + d.modeIcon} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.url}</span>
            <span style={{ color: d.liveColor }}>{d.liveLabel}</span>
          </div>
          <div style={{ minHeight: 220, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
            <Orb size={34} state={ui.s.orb} />
            <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-neutral-500)' }}>{d.nowLabel}</div>
            <div style={{ fontSize: 20, lineHeight: 1.3, textWrap: 'pretty' } as React.CSSProperties}>{d.current}</div>
            {d.thought && <ThoughtLine text={d.thought} live={d.thinking} clamp={4} size={13} />}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h6 style={{ margin: '0 0 var(--space-3)', color: 'var(--color-neutral-400)' }}>Activity</h6>
          {d.steps.map((st, k) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', gap: 10, padding: '7px 0', alignItems: 'start' }}>
              <i className={'ph ' + st.icon} style={{ fontSize: 16, marginTop: 2, color: st.color }} />
              <div style={{ fontSize: 13, lineHeight: 1.45, color: st.textColor }}>{st.text}</div>
              <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', paddingTop: 2 }}>{st.time}</div>
            </div>
          ))}
          {d.upcoming.map((st, k) => (
            <div key={'u' + k} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', gap: 10, padding: '7px 0', alignItems: 'start', color: 'var(--color-neutral-600)' }}>
              <i className="ph ph-circle-dashed" style={{ fontSize: 16, marginTop: 2 }} />
              <div style={{ fontSize: 13, lineHeight: 1.45 }}>{st.text}</div>
            </div>
          ))}
        </div>
      </div>

      <ThoughtList thoughts={d.thoughts} />

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {d.canPause && <button className="btn btn-secondary" onClick={() => j.togglePause(t.id)}><i className={'ph ' + d.pauseIcon} />{d.pauseLabel}</button>}
        <button className="btn btn-secondary" onClick={() => set({ panel: 'transcript', input: `About "${t.title}": ` })}><i className="ph ph-chat-circle-text" />Ask about this task</button>
      </div>
    </div>
  );
}

function TasksPanel({ ui }: { ui: Ui }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div className="text-muted" style={{ fontSize: 13, marginBottom: 'var(--space-3)' }}>{ui.summary}</div>
      {ui.allTasks.map(t => (
        <button key={t.id} className="task-row" onClick={() => ui.openTask(t.id)}>
          <span style={{ width: 6, height: 6, flex: 'none', borderRadius: '50%', background: t.dot }} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{t.title}</span>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.current}</span>
          </div>
          {t.hasFix && <i className="ph ph-wrench" style={{ color: 'var(--color-accent-300)' }} />}
          <span style={{ fontSize: 12, color: 'var(--color-neutral-400)' }}>{t.statusLabel}</span>
        </button>
      ))}
    </div>
  );
}

function ApprovalsPanel({ ui }: { ui: Ui }) {
  const { j } = ui;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13, color: 'var(--color-neutral-400)' }}>
        Jarvis works on its own, asks when something is unclear, and checks with you before it can<span className="tag tag-neutral">Send</span><span className="tag tag-neutral">Pay</span><span className="tag tag-neutral">Delete</span>
      </div>
      {ui.waiting.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(280px,100%),1fr))', gap: 'var(--space-4)' }}>
          {ui.waiting.map(a => a.isQuestion ? (
            <div key={a.id} className="card glow-card" style={{ gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
              <div className="card-kicker">Question · {a.app}</div>
              <QuestionBox ui={ui} id={a.id} question={a.question!} why={a.why} options={a.options} compact />
              <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>From: {a.title}</div>
              <button className="btn btn-ghost" onClick={() => ui.openTask(a.id)} style={{ alignSelf: 'flex-end' }}>View task</button>
            </div>
          ) : (
            <div key={a.id} className="card glow-card" style={{ gap: 'var(--space-3)', padding: 'var(--space-6)' }}>
              <div className="card-kicker">{a.risk} · {a.app}</div>
              <div className="card-title">{a.action}</div>
              <div style={{ fontSize: 13, color: 'var(--color-neutral-400)' }}>{a.detail}</div>
              {a.preview && <pre className="approval-preview">{a.preview}</pre>}
              <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>From: {a.title}</div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={() => j.decide(a.id, true)}><i className="ph ph-check" />Approve</button>
                <button className="btn btn-secondary" onClick={() => j.decide(a.id, false)}>Decline</button>
                <button className="btn btn-ghost" onClick={() => ui.openTask(a.id)} style={{ marginLeft: 'auto' }}>View task</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 'var(--space-6)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', color: 'var(--color-neutral-400)', fontSize: 14 }}>
          Nothing is waiting on you. Jarvis will ask here before the next send, payment or deletion.
        </div>
      )}
      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={{ margin: '0 0 var(--space-2)', color: 'var(--color-neutral-400)' }}>Decided today</h6>
        {ui.s.decisions.map((x, i) => (
          <div key={i} className="fade-rule" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap', padding: '10px 0' }}>
            <span className={'tag ' + (x.ok ? 'tag-accent' : 'tag-neutral')}>{x.ok ? 'Approved' : 'Declined'}</span>
            <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14 }}>{x.action}</span>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>{x.title}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>{x.time}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function MemoryPanel({ ui }: { ui: Ui }) {
  const { s, set } = { s: ui.s, set: ui.j.set };
  const NODES = s.mem.nodes;
  const POS = Object.fromEntries(NODES.map(n => [n.id, n]));
  const EDGES = s.mem.edges.filter(([a, b]) => POS[a] && POS[b]);
  const q = s.memQ.trim().toLowerCase();
  const match = (n: MemNode) => !q || (n.label + ' ' + n.type + ' ' + n.facts.join(' ')).toLowerCase().includes(q);
  const linked = new Set(EDGES.filter(e => e.includes(s.node)).flat());
  const cur = POS[s.node] ?? NODES[0];
  if (!cur) return <div className="text-muted" style={{ fontSize: 13 }}>Memory is empty.</div>;
  const rows = NODES.filter(match).flatMap(n => n.facts.map(f => ({ n, f })));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search memory" value={s.memQ} onChange={e => set({ memQ: e.target.value })} style={{ flex: 1, minWidth: 200, maxWidth: 420 }} />
        <div className="seg" style={{ marginLeft: 'auto' }}>
          {(['Graph', 'List', 'Both'] as MemMode[]).map(m => (
            <label key={m} className="seg-opt"><input type="radio" name="memmode" checked={s.memMode === m} onChange={() => set({ memMode: m })} />{m}</label>
          ))}
        </div>
      </div>

      {s.memMode !== 'List' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'flex-start' }}>
          <div style={{ flex: '2 1 420px', minWidth: 0, position: 'relative', height: 440, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'radial-gradient(55% 55% at 50% 50%, var(--color-accent-900), transparent 75%), var(--color-surface)', boxShadow: 'var(--shadow-sm)' }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              {EDGES.map(([a, b]) => {
                const on = a === s.node || b === s.node;
                return <line key={a + b} x1={POS[a].x} y1={POS[a].y} x2={POS[b].x} y2={POS[b].y} stroke={on ? 'var(--color-accent)' : 'var(--color-neutral-700)'} strokeWidth={on ? 1.4 : 1} strokeOpacity={on ? 0.9 : 0.6} vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
            {NODES.map(n => {
              const sel = n.id === s.node, size = n.type === 'Organization' ? 18 : 11;
              return (
                <button key={n.id} className="graph-node" onClick={() => set({ node: n.id })} style={{ left: n.x + '%', top: n.y + '%', opacity: match(n) ? 1 : 0.25 }}>
                  <span style={{ width: size, height: size, borderRadius: '50%', background: TYPE_FILL[n.type], boxShadow: sel ? '0 0 0 4px color-mix(in srgb, var(--color-accent) 30%, transparent), 0 0 18px var(--color-accent)' : 'none' }} />
                  <span style={{ fontSize: 11, whiteSpace: 'nowrap', color: sel ? 'var(--color-text)' : linked.has(n.id) ? 'var(--color-neutral-200)' : 'var(--color-neutral-500)' }}>{n.label}</span>
                </button>
              );
            })}
          </div>
          <div className="card elev-sm" style={{ flex: '1 1 260px', padding: 'var(--space-6)', gap: 'var(--space-4)' }}>
            <div className="card-kicker">{cur.type}</div>
            <div className="card-title" style={{ fontSize: 20 }}>{cur.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cur.facts.map(f => (
                <div key={f} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--color-neutral-300)' }}>
                  <i className="ph ph-dot-outline" style={{ marginTop: 3, color: 'var(--color-accent)' }} /><span>{f}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>Connected to</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[...linked].filter(x => x !== s.node).map(x => (
                  <button key={x} className="tag tag-neutral link-tag" onClick={() => set({ node: x })}>{POS[x].label}</button>
                ))}
              </div>
            </div>
            <div className="card-meta"><i className="ph ph-book-open" />{cur.source}</div>
          </div>
        </div>
      )}

      {s.memMode !== 'Graph' && (
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <h6 style={{ margin: '0 0 var(--space-2)', color: 'var(--color-neutral-400)' }}>{rows.length} facts</h6>
          {rows.map(({ n, f }) => (
            <button key={n.id + f} className="mem-row" onClick={() => set({ node: n.id, memMode: s.memMode === 'List' ? 'Both' : s.memMode })}>
              <span style={{ flex: '0 0 180px', fontSize: 14, fontWeight: 500 }}>{n.label}</span>
              <span style={{ flex: 1, minWidth: 220, fontSize: 13, color: 'var(--color-neutral-300)' }}>{f}</span>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>{n.source}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

const PREFS: IntegrationPref[] = ['API first', 'Browser only', 'Both'];

/** "OpenAI · gpt-5 · key ending 1a2b", or what's missing. */
function aiLine(ui: Ui) {
  const k = ui.s.key, cur = k?.providers?.find(p => p.id === k.provider);
  if (!k || !cur) return 'Jarvis needs an API key to talk to a model';
  if (!k.configured) return `Jarvis needs a ${cur.name} API key`;
  return [cur.name, k.model, k.hint && 'key ending ' + k.hint.replace('…', ''), k.source === 'env' && 'from .env'].filter(Boolean).join(' · ');
}

function IntegrationsPanel({ ui }: { ui: Ui }) {
  const { setIntegration } = ui.j;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <div className="text-muted" style={{ fontSize: 13 }}>Jarvis uses an API where one exists and drives the web app like a person where it doesn't.</div>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <h6 style={{ margin: 0, color: 'var(--color-neutral-400)' }}>Jarvis</h6>
        <div className="card elev-sm" style={{ padding: 'var(--space-6)', gap: 'var(--space-3)', maxWidth: 520 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <i className="ph ph-key" style={{ fontSize: 22, color: 'var(--color-accent-400)' }} />
            <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>AI provider</div>
            <span className={'tag ' + (ui.s.key?.configured ? 'tag-accent' : 'tag-neutral')}>{ui.s.key?.configured ? 'Connected' : 'Missing'}</span>
          </div>
          <div className="card-meta">
            <span style={{ flex: 1 }}>{aiLine(ui)}</span>
            <button className="btn btn-ghost" onClick={() => ui.j.set({ setup: true })} style={{ fontSize: 12 }}>{ui.s.key?.configured ? 'Change' : 'Add key'}</button>
          </div>
        </div>
      </section>
      {ui.s.integ.map(g => (
        <section key={g.g} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <h6 style={{ margin: 0, color: 'var(--color-neutral-400)' }}>{g.g}</h6>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(260px,100%),1fr))', gap: 'var(--space-4)' }}>
            {g.items.map(it => (
              <div key={it.id} className="card elev-sm" style={{ padding: 'var(--space-6)', gap: 'var(--space-3)', opacity: it.on ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <i className={'ph ' + it.icon} style={{ fontSize: 22, color: 'var(--color-accent-400)' }} />
                  <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{it.name}</div>
                  <span className={'tag ' + (it.on ? 'tag-accent' : 'tag-neutral')}>{it.on ? 'Connected' : 'Off'}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--color-neutral-400)', flex: 1 }}>{it.desc}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {it.modes.map(m => (
                    <span key={m} className="tag tag-outline" style={{ gap: 5 }}>
                      <i className={'ph ' + (m === 'API' ? 'ph-plugs-connected' : 'ph-cursor-click')} />{m === 'API' ? 'API' : 'Browser automation'}
                    </span>
                  ))}
                </div>
                {it.modes.length > 1 && (
                  <div className="seg" style={{ alignSelf: 'flex-start' }}>
                    {PREFS.map(c => (
                      <label key={c} className="seg-opt" style={{ fontSize: 12, padding: '5px 10px' }}>
                        <input type="radio" name={it.id} checked={(it.pref || 'Both') === c} onChange={() => setIntegration(it.id, { pref: c })} />{c}
                      </label>
                    ))}
                  </div>
                )}
                {it.update && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent-900)', boxShadow: '0 0 0 1px var(--color-accent-800)', fontSize: 12 }}>
                    <span style={{ color: 'var(--color-neutral-200)' }}>{it.update.summary}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, color: 'var(--color-neutral-400)' }}>{it.update.files.length} file{it.update.files.length === 1 ? '' : 's'}</span>
                      <button className="btn btn-ghost" onClick={ui.j.applyUpdate} style={{ fontSize: 12 }}><i className="ph ph-arrow-circle-up" />Apply now</button>
                    </span>
                  </div>
                )}
                {it.code && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent-900)', boxShadow: '0 0 0 1px var(--color-accent-800)', fontSize: 12 }}>
                    <span style={{ color: 'var(--color-neutral-300)' }}>Sign in at <a href={it.code.verificationUri} target="_blank" rel="noreferrer">{it.code.verificationUri.replace(/^https?:\/\//, '')}</a> with code</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <code style={{ fontSize: 16, letterSpacing: '.12em', color: 'var(--color-accent-200)' }}>{it.code.userCode}</code>
                      <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(it.code!.userCode)} style={{ fontSize: 12 }}><i className="ph ph-copy" />Copy</button>
                    </span>
                  </div>
                )}
                <div className="card-meta">
                  <span style={{ flex: 1 }}>{it.last}</span>
                  {it.available === false ? (
                    <span style={{ fontSize: 12 }}>{it.engine ? 'Needs setup' : 'Coming later'}</span>
                  ) : it.id !== 'memory' && (
                    <button className="btn btn-ghost" disabled={!!it.code} onClick={() => setIntegration(it.id, { on: !it.on, last: it.on ? 'Not connected' : 'Connected just now' })} style={{ fontSize: 12 }}>
                      {it.on ? (it.engine === 'microsoft' ? 'Disconnect' : 'Turn off') : it.engine && it.engine !== 'microsoft' ? 'Turn on' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Actions Jarvis always pauses on, whatever else is allowed (see server/agent/tools/risk.ts). */
const GATES: [string, string, string][] = [
  ['ph-paper-plane-tilt', 'Send', 'Emails, Teams messages, calendar invites and web posts'],
  ['ph-credit-card', 'Pay', 'Payments, purchases and checkouts'],
  ['ph-trash', 'Delete', 'Files, records and mail'],
  ['ph-warning-octagon', 'Irreversible', 'Recursive deletes, disk, registry and force-push commands, even with admin on'],
  ['ph-git-diff', 'Patch', 'Updates to Jarvis itself; you see the diff first'],
];

const MIC_LABEL: Record<string, string> = { granted: 'Allowed', denied: 'Blocked', prompt: 'Asks when needed' };

function SettingRow({ icon, title, sub, children }: { icon: string; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="fade-rule" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap', padding: '12px 0' }}>
      <i className={'ph ' + icon} style={{ fontSize: 18, color: 'var(--color-accent-400)' }} />
      <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14 }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function OnOff({ name, on, set }: { name: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="seg">
      {[true, false].map(v => (
        <label key={String(v)} className="seg-opt" style={{ fontSize: 12, padding: '5px 12px' }}>
          <input type="radio" name={name} checked={on === v} onChange={() => set(v)} />{v ? 'On' : 'Off'}
        </label>
      ))}
    </div>
  );
}

function SettingsPanel({ ui }: { ui: Ui }) {
  const { s, j } = ui;
  const v = s.voice;
  const w = window as unknown as Record<string, unknown>;
  const hasVoice = !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  const [mic, setMic] = useState('');
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then(p => { setMic(p.state); p.onchange = () => setMic(p.state); })
      .catch(() => setMic(''));
  }, []);
  const h6 = { margin: 0, color: 'var(--color-neutral-400)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={h6}>AI model</h6>
        <SettingRow icon="ph-brain" title="Provider and model" sub={aiLine(ui) + '. Claude, OpenAI, Gemini, Azure OpenAI, or a local / OpenAI-compatible server.'}>
          <span className={'tag ' + (s.key?.configured ? 'tag-accent' : 'tag-neutral')}>{s.key?.configured ? 'Connected' : 'Missing'}</span>
          <button className="btn btn-ghost" onClick={() => j.set({ setup: true })} style={{ fontSize: 12 }}>{s.key?.configured ? 'Change' : 'Set up'}</button>
        </SettingRow>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={h6}>Admin escalation</h6>
        <SettingRow icon="ph-shield-check" title="Administrator rights" sub={j.live
          ? 'Jarvis asks once per session when a task needs admin; you confirm the Windows UAC prompt. Elevated commands then run without asking again until you end the session.'
          : 'Only available with the live agent.'}>
          <span className={'tag ' + (s.admin ? 'tag-accent' : 'tag-neutral')}>{s.admin ? 'On this session' : 'Off'}</span>
          <button className="btn btn-ghost" disabled={!j.live || !s.admin} onClick={j.revokeAdmin} style={{ fontSize: 12 }}>End admin session</button>
        </SettingRow>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={h6}>Permissions</h6>
        <div className="text-muted" style={{ fontSize: 13, padding: '6px 0' }}>Jarvis works on its own and always asks before these.</div>
        {GATES.map(([icon, name, sub]) => (
          <SettingRow key={name} icon={icon} title={name} sub={sub}><span className="tag tag-outline" style={{ gap: 5 }}><i className="ph ph-lock-simple" />Asks first</span></SettingRow>
        ))}
        <SettingRow icon="ph-microphone" title="Microphone" sub="Browser permission for voice input and the wake word">
          <span className={'tag ' + (mic === 'granted' ? 'tag-accent' : 'tag-neutral')}>{MIC_LABEL[mic] || 'Unknown'}</span>
        </SettingRow>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={h6}>Voice</h6>
        <SettingRow icon="ph-timer" title="End my turn after silence" sub={`Short pauses mid-sentence don't end your turn. ${SILENCE_MIN}–${SILENCE_MAX} s, default ${SILENCE_MIN} s.`}>
          <input type="range" aria-label="Silence before the turn ends" min={SILENCE_MIN} max={SILENCE_MAX} step={0.5} value={v.silenceSec}
            onChange={e => j.setVoice({ silenceSec: Number(e.target.value) })} style={{ width: 160, accentColor: 'var(--color-accent)' }} />
          <span style={{ width: 44, fontSize: 13, textAlign: 'right' }}>{v.silenceSec.toFixed(1)} s</span>
          {v.silenceSec !== SILENCE_MIN && <button className="btn btn-ghost" onClick={() => j.setVoice({ silenceSec: SILENCE_MIN })} style={{ fontSize: 12 }}>Reset</button>}
        </SettingRow>
        <SettingRow icon="ph-chats-circle" title="Carry context between voice turns" sub="Each turn is sent with the conversation so far, so follow-ups just work.">
          <span className="tag tag-accent" style={{ gap: 5 }}><i className="ph ph-lock-simple" />Always on</span>
        </SettingRow>
        <SettingRow icon={ui.speakIcon} title="Spoken replies" sub="Jarvis reads its answers aloud">
          <OnOff name="speak" on={s.speak} set={on => { if (on !== s.speak) j.toggleSpeak(); }} />
        </SettingRow>
        {!hasVoice && <div className="text-muted" style={{ fontSize: 13, paddingTop: 6 }}>Voice input isn't available in this browser. Use Edge or Chrome.</div>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column' }}>
        <h6 style={h6}>Wake word</h6>
        <SettingRow icon="ph-waveform" title="Listen for the wake word" sub="While Jarvis is idle and this window is open. Pauses while you talk or Jarvis replies.">
          <OnOff name="wake" on={v.wake} set={on => j.setVoice({ wake: on })} />
        </SettingRow>
        <SettingRow icon="ph-quotes" title="Wake phrase" sub="Say it, then your request">
          <input className="input" aria-label="Wake phrase" value={v.wakeWord} onChange={e => j.setVoice({ wakeWord: e.target.value })}
            onBlur={() => { if (!v.wakeWord.trim()) j.setVoice({ wakeWord: 'Hey Jarvis' }); }} style={{ width: 200 }} />
        </SettingRow>
        {v.wake && !hasVoice && <div className="text-muted" style={{ fontSize: 13, paddingTop: 6 }}>This browser can't listen for a wake word.</div>}
      </section>
    </div>
  );
}

export function Modal({ ui }: { ui: Ui }) {
  const modal = ui.modal!;
  const wide = modal === 'memory' || modal === 'integrations';
  const m = ui.isMobile;
  const title = modal === 'task' && ui.selT ? ui.selT.app : MODALS[modal][1];
  return (
    <div className="dialog-backdrop" onClick={ui.closePanel} style={{ position: 'absolute', zIndex: 30, padding: m ? 0 : 32, backdropFilter: 'blur(6px)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        style={{
          width: m ? '100%' : wide ? 'min(1120px, 100%)' : modal === 'task' ? 'min(920px, 100%)' : 'min(720px, 100%)',
          height: m ? '100%' : wide ? '88%' : 'auto', maxHeight: '100%', display: 'flex', flexDirection: 'column',
          borderRadius: m ? 0 : 'var(--radius-lg)', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 10px 24px' }}>
          <i className={'ph ' + MODALS[modal][0]} style={{ fontSize: 18, color: 'var(--color-accent-400)' }} />
          <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{title}</div>
          <button className="btn btn-icon btn-secondary" onClick={ui.closePanel} title="Close"><i className="ph ph-x" style={{ fontSize: 17 }} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 24px 28px' }}>
          {modal === 'task' && ui.selT && <TaskPanel ui={ui} t={ui.selT} />}
          {modal === 'tasks' && <TasksPanel ui={ui} />}
          {modal === 'approvals' && <ApprovalsPanel ui={ui} />}
          {modal === 'memory' && <MemoryPanel ui={ui} />}
          {modal === 'integrations' && <IntegrationsPanel ui={ui} />}
          {modal === 'settings' && <SettingsPanel ui={ui} />}
        </div>
      </div>
    </div>
  );
}
