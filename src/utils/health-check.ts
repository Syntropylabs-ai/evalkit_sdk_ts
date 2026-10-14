/**
 * Health and readiness probes: load balancers and orchestrators poll them every few seconds, so each would be
 * a trace of its own that says nothing about the app. A probe is told by whole path segment, so /healthcare
 * and /api/health-records are the app's own routes and are recorded. The Python SDK decides by the same rule.
 */

const PROBE_SEGMENTS: ReadonlySet<string> = new Set([
  'health', 'healthz', 'healthcheck', 'health-check', 'health_check',
  'livez', 'readyz', 'startupz',
]);

// What follows a health segment in a probe path: /health/live, /actuator/health/readiness.
const PROBE_QUALIFIERS: ReadonlySet<string> = new Set([
  'live', 'liveness', 'ready', 'readiness', 'startup', 'started', 'alive',
]);

// The scheme and authority of an absolute URL; a path whose query holds a URL (/cb?next=http://h/health) is
// not one.
const ORIGIN_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

function pathSegments(url: string): string[] {
  const origin = ORIGIN_RE.exec(url);
  const rest = origin ? url.slice(origin[0].length) : url;
  const end = rest.search(/[?#]/);
  const path = end < 0 ? rest : rest.slice(0, end);
  return path.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
}

/**
 * Whether a URL or a request path is a health or readiness probe: its last path segment names one, or a
 * health segment is followed only by a liveness or readiness qualifier.
 */
export function isHealthCheck(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const segments = pathSegments(url);
    if (!segments.length) return false;
    const last = segments[segments.length - 1];
    if (PROBE_SEGMENTS.has(last)) return true;
    return segments.length >= 2 && PROBE_QUALIFIERS.has(last) && PROBE_SEGMENTS.has(segments[segments.length - 2]);
  } catch {
    return false;
  }
}
