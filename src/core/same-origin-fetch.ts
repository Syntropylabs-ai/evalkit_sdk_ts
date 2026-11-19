/**
 * fetch for the SDK's own calls, each of which carries a credential (the subscription key, or a provider key in
 * the body). fetch follows a redirect with every header and, on a 307 or 308, the body too: a redirect from a
 * misconfigured proxy or a compromised host would hand the key to whatever server it names. Redirects are
 * followed here only within the same origin, or from http to https on the same host; one to anywhere else
 * comes back as its own status, with a JSON `message` and a status text saying it was refused, so each caller
 * reports it the way it reports any other refusal.
 *
 * Imports nothing, so the coding-agent CLI can use it without loading the tracing runtime.
 */

const MAX_REDIRECTS = 5;
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const BODY_HEADERS = new Set(["content-type", "content-encoding", "content-length"]);

function origin(url: URL): { protocol: string; host: string; port: string } {
  return { protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port || DEFAULT_PORTS[url.protocol] || "" };
}

/** Whether a redirect from `from` to `to` stays with the same server: the same scheme, host and port, or http
 *  upgraded to https on the same host at the default ports. */
export function sameOrigin(from: string | URL, to: string | URL): boolean {
  let a: ReturnType<typeof origin>;
  let b: ReturnType<typeof origin>;
  try {
    a = origin(new URL(String(from)));
    b = origin(new URL(String(to)));
  } catch {
    return false;
  }
  if (a.protocol === b.protocol && a.host === b.host && a.port === b.port) return true;
  return a.protocol === "http:" && b.protocol === "https:" && a.host === b.host && a.port === "80" && b.port === "443";
}

function withoutBodyHeaders(headers: RequestInit["headers"]): Headers {
  const out = new Headers(headers);
  for (const name of BODY_HEADERS) out.delete(name);
  return out;
}

function refused(status: number, target: URL): Response {
  const message = `refused a redirect to ${target.protocol}//${target.host}: the request carries a credential, which goes only to the server it was sent to`;
  return new Response(JSON.stringify({ message }), { status, statusText: message, headers: { "content-type": "application/json" } });
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The connection is released either way.
  }
}

export async function fetchSameOrigin(input: string, init: RequestInit = {}): Promise<Response> {
  let url = input;
  let request: RequestInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...request, redirect: "manual" });
    if (res.status < 300 || res.status > 399 || res.status === 304) return res;
    const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
    if (!location) return res;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return res;
    }
    await discard(res);
    if (!sameOrigin(url, next)) return refused(res.status, next);
    if (hop >= MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects from ${input}`);
    // As fetch itself does: a 303, or a 301 or 302 after a POST, is followed with a GET and no body.
    const method = (request.method ?? "GET").toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      request = { ...request, method: method === "HEAD" ? "HEAD" : "GET", body: undefined, headers: withoutBodyHeaders(request.headers) };
    }
    url = next.href;
  }
}
