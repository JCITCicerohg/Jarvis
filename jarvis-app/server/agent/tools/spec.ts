import type Anthropic from '@anthropic-ai/sdk';
import type { Approval, StepKind } from '../../../src/types.ts';

export interface ToolCtx { taskId: string; signal: AbortSignal }
export interface ToolOutput {
  text: string;
  isError?: boolean;
  /** Ends the task after this turn (the report tool). */
  final?: boolean;
  /** Optional image returned to the model alongside the text (e.g. a screenshot). */
  image?: { data: string; mediaType: 'image/png' | 'image/jpeg' };
}

export interface ToolSpec<I> {
  def: Anthropic.Tool;
  parse(input: Record<string, unknown>): I | string;
  step(i: I): { kind: StepKind; text: string } | null;
  gate?(i: I): Promise<Approval | null> | Approval | null;
  run(i: I, ctx: ToolCtx): Promise<ToolOutput | string> | ToolOutput | string;
}

/* Small input validators: return the value, or throw a message the model can act on. */
export const str = (o: Record<string, unknown>, k: string, required = true) => {
  const v = o[k];
  if (typeof v === 'string' && v.trim()) return v;
  if (required) throw new Error(`"${k}" must be a non-empty string`);
  return undefined;
};
export const strs = (o: Record<string, unknown>, k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
export const num = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
export const bool = (o: Record<string, unknown>, k: string) => o[k] === true;
export const parser = <I>(fn: (o: Record<string, unknown>) => I) => (o: Record<string, unknown>): I | string => {
  try { return fn(o); } catch (e) { return (e as Error).message; }
};
export const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const tool = <I>(t: ToolSpec<I>) => t as unknown as ToolSpec<unknown>;
