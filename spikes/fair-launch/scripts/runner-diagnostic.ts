/** Keep useful failure context while excluding seeds, keys, salts and long transaction hex. */
export function sanitizeRunnerDiagnostic(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'Unknown runner error.';
  return message
    .replace(/\b(seed|secret|salt|private[\s_-]*key|signing[\s_-]*key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])/gi, '[redacted hex]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}
