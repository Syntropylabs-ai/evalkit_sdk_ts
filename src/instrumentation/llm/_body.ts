import { boundedText } from "../../core/serialize.js";
import { valueLimitBytes } from "../../core/truncate.js";

/**
 * A request or response body as JSON. It is kept whole here: a value past the per-value limit is cut where
 * it is set on the span, keeping its start and its end, and the span records its original size. A body JSON
 * cannot express (a cycle, a BigInt) is written as far as it can be.
 */
export function safeBody(obj: unknown): string | undefined {
  if (obj == null) return undefined;
  try {
    const s = JSON.stringify(obj);
    if (s !== undefined) return s;
  } catch {
    // Written by the bounded serialiser below.
  }
  return boundedText(obj, valueLimitBytes());
}
