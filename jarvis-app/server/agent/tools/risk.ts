/**
 * Flags shell commands with irreversible data-loss consequences. These always need a
 * per-command approval, even after the session-wide admin grant (prompt Rule 6).
 * Matching is per pipeline segment boundary (`|`, `;`, `&`, newline) where it matters.
 */
const SEG = String.raw`[^|;&\n]*`;

const RULES: [RegExp, string][] = [
  [new RegExp(String.raw`\b(remove-item|rm|ri|del|erase|rd|rmdir)\b${SEG}\s(-r(ecurse)?\b|-rf\b|-fr\b|/s\b)`, 'i'), 'Recursive delete'],
  [/\|\s*(remove-item|rm|ri|del|erase)\b/i, 'Delete of piped items'],
  [/\b(format-volume|clear-disk|initialize-disk|remove-partition|diskpart)\b|(^|[\s;&|])format(\.com)?\s+[a-z]:/i, 'Disk operation'],
  [/\breg(\.exe)?\s+delete\b/i, 'Registry delete'],
  [new RegExp(String.raw`\bremove-item(property)?\b${SEG}(\b(hklm|hkcu|hkcr|hku|hkcc):|registry::)`, 'i'), 'Registry delete'],
  [new RegExp(String.raw`\bgit\b${SEG}\bpush\b${SEG}(\s--force(-with-lease)?\b|\s-f\b)`, 'i'), 'Force push'],
  [new RegExp(String.raw`\bgit\b${SEG}\breset\b${SEG}--hard\b`, 'i'), 'Hard reset'],
  [new RegExp(String.raw`\bgit\b${SEG}\bclean\b${SEG}\s-[a-z]*f`, 'i'), 'git clean'],
  [/\b(clear-recyclebin)\b|\bcipher(\.exe)?\s+\/w\b/i, 'Permanent erase'],
];

/** Returns a short reason when the command is irreversible, else null. */
export function irreversibleReason(command: string): string | null {
  for (const [re, reason] of RULES) if (re.test(command)) return reason;
  return null;
}

/**
 * Browser clicks whose visible label implies sending, paying or deleting. The label
 * comes from the page snapshot (accessible name, text, value or title).
 */
export function clickRisk(label: string): 'Send' | 'Pay' | 'Delete' | null {
  const l = label.toLowerCase();
  if (/\b(pay( now)?|purchase|buy now|place (your )?order|checkout|check out|transfer( funds)?|confirm payment|submit payment|approve payment)\b/.test(l)) return 'Pay';
  if (/\b(delete|remove|trash|discard|erase|permanently)\b/.test(l)) return 'Delete';
  if (/\b(send|post|publish|reply( all)?|forward|share|invite)\b/.test(l)) return 'Send';
  return null;
}

/** DuckDB statements that write files or attach databases other than in-memory. */
export function sqlWriteReason(sql: string): string | null {
  if (/\bcopy\b[\s\S]*\bto\b/i.test(sql)) return 'Write a file from SQL';
  if (/\bexport\s+database\b/i.test(sql)) return 'Export a database to files';
  if (/\battach\b(?!\s+':memory:')/i.test(sql)) return 'Attach and modify a database file';
  return null;
}
