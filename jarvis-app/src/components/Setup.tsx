import { useEffect, useState, type FormEvent } from 'react';
import type { AiProvider } from '../types';
import type { Ui } from '../ui';
import { Orb } from './Orb';

const KEY_HINT: Record<AiProvider, string> = { anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…', azure: 'Key 1 from the Azure OpenAI resource', compatible: 'Leave empty if the server needs none' };

/** In-app setup: pick the AI provider and model, and enter or replace its API key. The server checks it, then stores the key DPAPI-encrypted. */
export function Setup({ ui }: { ui: Ui }) {
  const { s, j } = ui;
  const providers = s.key?.providers ?? [];
  const [provider, setProvider] = useState<AiProvider>(s.key?.provider ?? 'anthropic');
  const p = providers.find(x => x.id === provider);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(p?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(p?.baseUrl ?? '');
  const [probe, setProbe] = useState(p?.baseUrl ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const replacing = !!s.key?.configured;
  const canSave = !saving && (!!key.trim() || !!p?.configured);

  useEffect(() => {
    let on = true;
    setModels([]);
    j.listModels(provider, provider === 'compatible' || provider === 'azure' ? probe : '').then(m => { if (on) setModels(m); });
    return () => { on = false; };
  }, [provider, probe, j.listModels, s.key]);

  const pick = (id: AiProvider) => {
    const x = providers.find(y => y.id === id);
    setProvider(id);
    setModel(x?.model ?? '');
    setBaseUrl(x?.baseUrl ?? '');
    setProbe(x?.baseUrl ?? '');
    setKey('');
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(await j.saveKey({ provider, apiKey: key, model, baseUrl }));
    setSaving(false);
  };

  return (
    <div className="dialog-backdrop" style={{ position: 'absolute', zIndex: 40, padding: ui.isMobile ? 16 : 32, backdropFilter: 'blur(6px)' }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Set up Jarvis"
        onSubmit={submit}
        style={{
          width: 'min(480px, 100%)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', padding: 'var(--space-8)',
          borderRadius: 'var(--radius-lg)', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Orb size={28} state={saving ? 'thinking' : 'idle'} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--color-accent-300)' }}>Setup</div>
            <div style={{ fontSize: 18, fontWeight: 500 }}>{replacing ? 'AI provider and model' : 'Connect Jarvis to an AI model'}</div>
          </div>
          {replacing && (
            <button type="button" className="btn btn-icon btn-secondary" onClick={() => j.set({ setup: false })} title="Close"><i className="ph ph-x" style={{ fontSize: 17 }} /></button>
          )}
        </div>

        {providers.length > 1 && (
          <div className="seg" role="radiogroup" aria-label="AI provider" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
            {providers.map(x => (
              <label key={x.id} className="seg-opt" style={{ fontSize: 13, padding: '6px 12px' }} title={x.name}>
                <input type="radio" name="provider" checked={provider === x.id} onChange={() => pick(x.id)} />{x.short}
              </label>
            ))}
          </div>
        )}

        <div style={{ fontSize: 13, color: 'var(--color-neutral-400)', lineHeight: 1.5 }}>
          {p?.keyUrl ? (
            <>
              Paste an API key from <a href={p.keyUrl} target="_blank" rel="noreferrer">{new URL(p.keyUrl).host}</a>.
              Jarvis checks it with {p.name}, then saves it encrypted to this Windows account. It never leaves this PC except to call {p.name}.
            </>
          ) : (
            <>Any server that speaks the OpenAI chat-completions API: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter. Pick a model that supports tool calling.</>
          )}
        </div>

        {(provider === 'compatible' || provider === 'azure') && (
          <div className="field">
            <label htmlFor="baseurl">{provider === 'azure' ? 'Azure endpoint' : 'Base URL'}</label>
            <input
              id="baseurl" className="input" autoComplete="off" spellCheck={false} placeholder={provider === 'azure' ? 'https://<resource>.openai.azure.com' : 'http://localhost:11434/v1'}
              value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setError(''); }} onBlur={() => setProbe(baseUrl)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="apikey">{p?.needsKey === false ? 'API key (optional)' : 'API key'}</label>
          <input
            id="apikey" className="input" type="password" autoComplete="off" spellCheck={false} autoFocus
            placeholder={p?.hint ? `Current key ends ${p.hint.replace('…', '')}` : KEY_HINT[provider]}
            value={key} onChange={e => { setKey(e.target.value); setError(''); }}
          />
        </div>

        <div className="field">
          <label htmlFor="model">{provider === 'azure' ? 'Deployment name' : 'Model'}</label>
          <input
            id="model" className="input" list="jarvis-models" autoComplete="off" spellCheck={false} placeholder={p?.defaultModel}
            value={model} onChange={e => { setModel(e.target.value); setError(''); }}
          />
          <datalist id="jarvis-models">{models.map(m => <option key={m} value={m} />)}</datalist>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>
            Default {p?.defaultModel}{models.length ? ` · ${models.length} models available` : p?.configured ? '' : ' · save a key to list the models'}
          </div>
        </div>

        {p?.source === 'env' && (
          <div style={{ fontSize: 12, color: 'var(--color-neutral-500)' }}>Currently using {p.env} from .env. A key saved here takes priority.</div>
        )}
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--color-danger, #f87171)' }}><i className="ph ph-warning" /> {error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            <i className={'ph ' + (saving ? 'ph-circle-notch' : 'ph-key')} />{saving ? 'Checking…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
