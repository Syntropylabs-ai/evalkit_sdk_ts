// How long one export may spend waiting between attempts, every request in it included. The
// BatchSpanProcessor gives an export 30 s (OTEL_BSP_EXPORT_TIMEOUT) before it stops waiting for it, and a
// retry that lands after that only repeats a request whose outcome nobody reads any more.
export const RETRY_BUDGET_MS = 20_000;

// The longest single wait, whatever Retry-After asks for: a receiver shedding load names how long it wants,
// and a wait past this would use up the budget on one request.
export const MAX_RETRY_WAIT_MS = 10_000;

const BACKOFF_MS = [200, 600, 1800];

// 429 and 5xx say the receiver could not take the request now, so the same body may be accepted later.
// Every other 4xx is about the request itself and would be refused again.
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Retry-After as delta-seconds or an HTTP-date; undefined when absent or unreadable. An HTTP-date always
// names its day and month, and Date.parse reads bare numbers such as "1.5" as dates.
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[a-z]/i.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// The wait before attempt `attempt + 1`: what the receiver asked for, capped, or else the backoff step spread
// between half and one and a half times its value, so clients refused together do not return together.
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  now: number,
  random: () => number = Math.random,
): number {
  const asked = retryAfterMs(retryAfter, now);
  if (asked !== undefined) return Math.min(asked, MAX_RETRY_WAIT_MS);
  const step = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.round(step / 2 + random() * step);
}
