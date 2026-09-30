export interface Column { name: string; type: 'number' | 'date' | 'text' }
export type Value = string | number | null;
export interface TidyTable { columns: Column[]; rows: Record<string, Value>[]; period?: { start: string; end: string } }
