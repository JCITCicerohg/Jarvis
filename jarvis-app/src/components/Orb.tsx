import type { OrbState } from '../types';

const ANIM: Record<OrbState, string> = {
  thinking: 'orbThink 1.6s linear infinite',
  listening: 'orbListen .9s ease-in-out infinite',
  speaking: 'orbListen 1.4s ease-in-out infinite',
  idle: 'orbBreathe 5s ease-in-out infinite',
};

export function Orb({ size, state }: { size: number; state: OrbState }) {
  return (
    <div
      style={{
        width: size, height: size, flex: 'none', borderRadius: '50%',
        background: 'radial-gradient(circle at 34% 30%, var(--color-accent-200), var(--color-accent-500) 36%, var(--color-accent-800) 72%, var(--color-accent-900))',
        boxShadow: `0 0 ${Math.round(size * 0.55)}px color-mix(in srgb, var(--color-accent) ${state === 'idle' ? 28 : 55}%, transparent)`,
        animation: ANIM[state],
      }}
    />
  );
}
