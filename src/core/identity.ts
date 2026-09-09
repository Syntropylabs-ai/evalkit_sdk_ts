import { trace } from "@opentelemetry/api";

export interface Identity {
  userId?: string;
  sessionId?: string;
  deviceId?: string;
}

export const USER_ID_ATTRIBUTE = "evalkit.user_id";
export const SESSION_ID_ATTRIBUTE = "evalkit.session_id";
export const DEVICE_ID_ATTRIBUTE = "evalkit.device_id";

const MAX_TRACKED_TRACES = 4096;

const byTraceId = new Map<string, Identity>();

let processIdentity: Identity = {};

function pruned(identity: Identity): Identity {
  const out: Identity = {};
  if (identity.userId) out.userId = identity.userId;
  if (identity.sessionId) out.sessionId = identity.sessionId;
  if (identity.deviceId) out.deviceId = identity.deviceId;
  return out;
}

export function isIdentityEmpty(identity: Identity): boolean {
  return !identity.userId && !identity.sessionId && !identity.deviceId;
}

export function identityAttributes(identity: Identity): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (identity.userId) attributes[USER_ID_ATTRIBUTE] = identity.userId;
  if (identity.sessionId) attributes[SESSION_ID_ATTRIBUTE] = identity.sessionId;
  if (identity.deviceId) attributes[DEVICE_ID_ATTRIBUTE] = identity.deviceId;
  return attributes;
}

export function identityFromAttributes(attributes?: Record<string, string>): Identity {
  if (!attributes) return {};
  return pruned({
    userId: attributes[USER_ID_ATTRIBUTE],
    sessionId: attributes[SESSION_ID_ATTRIBUTE],
    deviceId: attributes[DEVICE_ID_ATTRIBUTE],
  });
}

export function identityFor(traceId?: string): Identity {
  const bound = traceId ? byTraceId.get(traceId) : undefined;
  return bound ? { ...processIdentity, ...bound } : processIdentity;
}

export function bindIdentity(traceId: string, identity: Identity): void {
  const merged = { ...(byTraceId.get(traceId) ?? {}), ...pruned(identity) };
  if (!byTraceId.has(traceId) && byTraceId.size >= MAX_TRACKED_TRACES) {
    const oldest = byTraceId.keys().next().value;
    if (oldest !== undefined) byTraceId.delete(oldest);
  }
  byTraceId.set(traceId, merged);
}

export function currentIdentity(): Identity {
  return identityFor(activeTraceId());
}

export function setUser(identity?: Identity | null): void {
  const traceId = activeTraceId();
  if (!identity || isIdentityEmpty(identity)) {
    if (traceId) byTraceId.delete(traceId);
    else processIdentity = {};
    return;
  }
  if (traceId) {
    bindIdentity(traceId, identity);
    return;
  }
  processIdentity = { ...processIdentity, ...pruned(identity) };
}

function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return ctx && ctx.traceId ? ctx.traceId : undefined;
}
