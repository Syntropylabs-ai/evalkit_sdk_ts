import { createContextKey, trace } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import * as asyncHooks from "node:async_hooks";

export interface Identity {
  userId?: string;
  sessionId?: string;
  deviceId?: string;
}

export const USER_ID_ATTRIBUTE = "evalkit.user_id";
export const SESSION_ID_ATTRIBUTE = "evalkit.session_id";
export const DEVICE_ID_ATTRIBUTE = "evalkit.device_id";
export const AGENT_NAME_ATTRIBUTE = "evalkit.agent_name";
export const GEN_AI_AGENT_NAME_ATTRIBUTE = "gen_ai.agent.name";

/**
 * The spellings the rest of the world uses for the same two ids. Every span carries both: our own
 * receiver reads either, and an OTLP collector or another backend only understands these. A caller
 * who sets the standard key by hand is understood too (see `sessionIdOf` / `userIdOf`).
 */
export const OTEL_SESSION_ID_ATTRIBUTE = "session.id";
export const OTEL_USER_ID_ATTRIBUTE = "user.id";

/** Session spellings accepted on a span, in the order the receiver resolves them. */
const SESSION_KEYS = [SESSION_ID_ATTRIBUTE, OTEL_SESSION_ID_ATTRIBUTE, "conversation.id", "gen_ai.conversation.id", "session_id"] as const;
const USER_KEYS = [USER_ID_ATTRIBUTE, OTEL_USER_ID_ATTRIBUTE, "enduser.id", "user_id"] as const;
const AGENT_KEYS = [AGENT_NAME_ATTRIBUTE, GEN_AI_AGENT_NAME_ATTRIBUTE, "agent.name"] as const;

const firstString = (attributes: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined => {
  if (!attributes) return undefined;
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
};

/** The session a span names, whichever spelling its author used. */
export function sessionIdOf(attributes?: Record<string, unknown>): string | undefined {
  return firstString(attributes, SESSION_KEYS);
}

/** The end user a span names, whichever spelling its author used. */
export function userIdOf(attributes?: Record<string, unknown>): string | undefined {
  return firstString(attributes, USER_KEYS);
}

/** The agent a span names, whichever spelling its author used. */
export function agentNameOf(attributes?: Record<string, unknown>): string | undefined {
  return firstString(attributes, AGENT_KEYS);
}

/** Both spellings: our receiver reads either, other OpenTelemetry backends only the gen_ai one. */
export function agentAttributes(agentName?: string | null): Record<string, string> {
  if (!agentName) return {};
  return { [AGENT_NAME_ATTRIBUTE]: agentName, [GEN_AI_AGENT_NAME_ATTRIBUTE]: agentName };
}

/** Identity plus the agent name: everything a span inherits from the scope it was started in. */
export interface Scope extends Identity {
  agentName?: string;
}

const MAX_TRACKED_TRACES = 4096;

/** Set by startTrace options/attributes and by setUser / setAgent called inside that trace. */
const byTraceId = new Map<string, Scope>();

interface ScopeStorage {
  getStore(): Scope | undefined;
  enterWith(scope: Scope): void;
  run<T>(scope: Scope, fn: () => T): T;
}

/**
 * Ambient scope lives in an AsyncLocalStorage so two requests handled concurrently by one Node
 * process never see each other's setUser. Runtimes without it (browsers, some edge workers) fall
 * back to one module-wide value, which is only correct for one user per process.
 */
const storage: ScopeStorage | undefined = (() => {
  try {
    const Ctor =
      (asyncHooks as unknown as { AsyncLocalStorage?: new () => ScopeStorage }).AsyncLocalStorage ??
      (globalThis as unknown as { AsyncLocalStorage?: new () => ScopeStorage }).AsyncLocalStorage;
    return typeof Ctor === "function" ? new Ctor() : undefined;
  } catch {
    return undefined;
  }
})();

let processScope: Scope = {};

/** Carries identity named on a startSpan down to every span opened inside it. */
const TAGGED_SCOPE_KEY = createContextKey("evalkit.scope");

interface StartedScope {
  ambient: Scope;
  tagged?: Scope;
}

/** What was in force where each span started; export runs later, outside the caller's context. */
const startedScopes = new WeakMap<object, StartedScope>();

function pruned(scope: Scope): Scope {
  const out: Scope = {};
  if (scope.userId) out.userId = scope.userId;
  if (scope.sessionId) out.sessionId = scope.sessionId;
  if (scope.deviceId) out.deviceId = scope.deviceId;
  if (scope.agentName) out.agentName = scope.agentName;
  return out;
}

function identityOnly(scope: Scope): Identity {
  const out: Identity = {};
  if (scope.userId) out.userId = scope.userId;
  if (scope.sessionId) out.sessionId = scope.sessionId;
  if (scope.deviceId) out.deviceId = scope.deviceId;
  return out;
}

function isScopeEmpty(scope: Scope): boolean {
  return isIdentityEmpty(scope) && !scope.agentName;
}

export function isIdentityEmpty(identity: Identity): boolean {
  return !identity.userId && !identity.sessionId && !identity.deviceId;
}

export function identityAttributes(identity: Identity): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (identity.userId) {
    attributes[USER_ID_ATTRIBUTE] = identity.userId;
    attributes[OTEL_USER_ID_ATTRIBUTE] = identity.userId;
  }
  if (identity.sessionId) {
    attributes[SESSION_ID_ATTRIBUTE] = identity.sessionId;
    attributes[OTEL_SESSION_ID_ATTRIBUTE] = identity.sessionId;
  }
  if (identity.deviceId) attributes[DEVICE_ID_ATTRIBUTE] = identity.deviceId;
  return attributes;
}

export function identityFromAttributes(attributes?: Record<string, unknown>): Identity {
  if (!attributes) return {};
  const deviceId = attributes[DEVICE_ID_ATTRIBUTE];
  return identityOnly({
    userId: userIdOf(attributes),
    sessionId: sessionIdOf(attributes),
    deviceId: typeof deviceId === "string" ? deviceId : undefined,
  });
}

/** Identity and agent a set of span attributes names, in any accepted spelling. */
export function scopeFromAttributes(attributes?: Record<string, unknown>): Scope {
  return pruned({ ...identityFromAttributes(attributes), agentName: agentNameOf(attributes) });
}

function ambientScope(): Scope {
  return storage ? storage.getStore() ?? {} : processScope;
}

function updateAmbient(next: (current: Scope) => Scope): void {
  if (storage) storage.enterWith(pruned(next(storage.getStore() ?? {})));
  else processScope = pruned(next(processScope));
}

export function identityFor(traceId?: string): Identity {
  const bound = traceId ? byTraceId.get(traceId) : undefined;
  return identityOnly(bound ? { ...ambientScope(), ...bound } : ambientScope());
}

export function bindIdentity(traceId: string, identity: Scope): void {
  const merged = { ...(byTraceId.get(traceId) ?? {}), ...pruned(identity) };
  if (!byTraceId.has(traceId) && byTraceId.size >= MAX_TRACKED_TRACES) {
    const oldest = byTraceId.keys().next().value;
    if (oldest !== undefined) byTraceId.delete(oldest);
  }
  byTraceId.set(traceId, merged);
}

function unbind(traceId: string, keep: (scope: Scope) => Scope): void {
  const bound = byTraceId.get(traceId);
  if (!bound) return;
  const rest = pruned(keep(bound));
  if (isScopeEmpty(rest)) byTraceId.delete(traceId);
  else byTraceId.set(traceId, rest);
}

export function currentIdentity(): Identity {
  return identityFor(activeTraceId());
}

export function currentAgentName(): string | undefined {
  const traceId = activeTraceId();
  const bound = traceId ? byTraceId.get(traceId) : undefined;
  return bound?.agentName ?? ambientScope().agentName;
}

/**
 * Inside a span: names the user of that whole trace. Outside one: names the user of everything
 * the current async context does from here on (the rest of a script, or one request's handler).
 */
export function setUser(identity?: Identity | null): void {
  const traceId = activeTraceId();
  if (!identity || isIdentityEmpty(identity)) {
    if (traceId) unbind(traceId, (scope) => ({ agentName: scope.agentName }));
    else updateAmbient((scope) => ({ agentName: scope.agentName }));
    return;
  }
  if (traceId) {
    bindIdentity(traceId, identityOnly(identity));
    return;
  }
  updateAmbient((scope) => ({ ...scope, ...identityOnly(identity) }));
}

/** Names the agent spans belong to, scoped exactly like setUser. `null` clears it. */
export function setAgent(agentName?: string | null): void {
  const traceId = activeTraceId();
  if (!agentName) {
    if (traceId) unbind(traceId, (scope) => identityOnly(scope));
    else updateAmbient((scope) => identityOnly(scope));
    return;
  }
  if (traceId) {
    bindIdentity(traceId, { agentName });
    return;
  }
  updateAmbient((scope) => ({ ...scope, agentName }));
}

export interface SessionScope {
  sessionId: string;
  userId?: string;
}

/**
 * Runs `fn` with a session (and optionally a user) in force for every span it starts, then
 * restores whatever was in force before, even when `fn` is async and interleaves with others.
 */
export function withSession<T>(session: SessionScope, fn: () => T): T {
  const next = { ...ambientScope(), ...pruned({ sessionId: session.sessionId, userId: session.userId }) };
  if (storage) return storage.run(next, fn);
  const previous = processScope;
  processScope = next;
  const restore = (): void => {
    processScope = previous;
  };
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  const thenable = result as unknown as { then?: unknown; finally?: (cb: () => void) => unknown };
  if (thenable && typeof thenable.then === "function" && typeof thenable.finally === "function") {
    return thenable.finally(restore) as unknown as T;
  }
  restore();
  return result;
}

/** A context whose spans inherit the identity and agent the given attributes name. */
export function withTaggedScope(ctx: OtelContext, attributes?: Record<string, unknown>): OtelContext {
  const own = scopeFromAttributes(attributes);
  if (isScopeEmpty(own)) return ctx;
  const inherited = ctx.getValue(TAGGED_SCOPE_KEY) as Scope | undefined;
  return ctx.setValue(TAGGED_SCOPE_KEY, { ...(inherited ?? {}), ...own });
}

/** Called from the span processor's onStart, which runs synchronously in the caller's context. */
export function captureStartScope(span: object, parentContext?: OtelContext): void {
  const ambient = ambientScope();
  const tagged = parentContext?.getValue(TAGGED_SCOPE_KEY) as Scope | undefined;
  if (isScopeEmpty(ambient) && !tagged) return;
  startedScopes.set(span, tagged ? { ambient, tagged } : { ambient });
}

/**
 * The scope a finished span belongs to, before its own attributes are consulted:
 * nearest tagged startSpan > trace binding > ambient scope where the span started.
 */
export function scopeForSpan(span: object, traceId: string): Scope {
  const started = startedScopes.get(span);
  const ambient = started ? started.ambient : storage ? {} : processScope;
  return { ...ambient, ...(byTraceId.get(traceId) ?? {}), ...(started?.tagged ?? {}) };
}

function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return ctx && ctx.traceId ? ctx.traceId : undefined;
}
