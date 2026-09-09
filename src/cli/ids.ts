import { createHash } from "node:crypto";

export const TRACE_ID_HEX = 32;
export const SPAN_ID_HEX = 16;

function digest(parts: Array<string | undefined>): string {
  return createHash("sha256").update(parts.map((part) => part ?? "").join("")).digest("hex");
}

export function traceId(...parts: Array<string | undefined>): string {
  return digest(parts).slice(0, TRACE_ID_HEX);
}

export function spanId(...parts: Array<string | undefined>): string {
  return digest(parts).slice(0, SPAN_ID_HEX);
}
