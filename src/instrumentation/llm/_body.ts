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
