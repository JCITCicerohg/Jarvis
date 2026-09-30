export type Cell = string | number | boolean | null;
export interface TextSection { heading: string | null; page: number | null; text: string }
export interface SheetData { name: string; rows: Cell[][] }
export type Parsed =
  | { kind: 'text'; sections: TextSection[]; emptyPages: number[] }
  | { kind: 'sheets'; sheets: SheetData[] }
  | { kind: 'unsupported'; reason: string };
