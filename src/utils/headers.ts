import type * as http from 'http';

export const MASK = '***';

export const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|proxy-authorization|x-secret|x-access-token|x-subscription-key|subscription-key|token|password)$/i;

let captureSecrets = false;

export function setCaptureSecrets(enabled: boolean): void {
  captureSecrets = enabled;
}

export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined> | http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] =
      !captureSecrets && SENSITIVE_HEADER_RE.test(k)
        ? MASK
        : Array.isArray(v)
          ? v.join(', ')
          : String(v);
  }
  return out;
}
