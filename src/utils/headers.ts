import type * as http from 'http';

export const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|proxy-authorization|x-secret|x-access-token|token|password)$/i;

export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined> | http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(k)) continue;
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}
