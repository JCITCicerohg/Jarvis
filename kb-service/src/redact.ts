/** Redact credential values from error text. */
export function redactCredentials(text: string, headers: Record<string, string>): string {
  let redacted = text;
  for (const value of Object.values(headers)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(escaped, 'g'), '[redacted]');
    // Also extract and redact the key if it's in Bearer form
    const bearerMatch = value.match(/^Bearer\s+(.+)$/);
    if (bearerMatch) {
      const keyEscaped = bearerMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      redacted = redacted.replace(new RegExp(keyEscaped, 'g'), '[redacted]');
    }
  }
  return redacted;
}
