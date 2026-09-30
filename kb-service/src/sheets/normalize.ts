import type { Cell } from '../parse/types.ts';
import { genericNormalize } from './generic.ts';
import { glActivityDetail, isGlActivityDetail } from './gl.ts';
import type { TidyTable } from './types.ts';

export type NormalizerName = 'gl-activity-detail' | 'generic';

/** Named normalizers first (matched by header signature), then the generic one. */
export function normalizeSheet(rows: Cell[][]): { normalizer: NormalizerName; table: TidyTable } | null {
  if (isGlActivityDetail(rows)) return { normalizer: 'gl-activity-detail', table: glActivityDetail(rows) };
  const t = genericNormalize(rows);
  return t && t.rows.length ? { normalizer: 'generic', table: t } : null;
}
