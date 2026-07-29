// Best-effort JSON of an LLM request/response object for the trace body.
// Never throws; capped to keep the span small (the exporter's fitEvent drops
// "gen_ai.request.body"/"gen_ai.response.body" first anyway). Returns undefined
// on total failure so callers can omit the attribute.
export function safeBody(obj: unknown, limit = 2 * 1024 * 1024): string | undefined {
  if (obj == null) return undefined;
  let s: string;
  try {
    s = JSON.stringify(obj);
  } catch {
    try {
      s = String(obj);
    } catch {
      return undefined;
    }
  }
  if (s == null) return undefined;
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}
