/**
 * What the app asked to keep out of traces: inbound routes, outgoing URLs and function names. The patterns are
 * compiled once, when a client is made, and every check after that is a walk over the compiled list, since
 * routes and URLs are checked on every request and every outgoing call. The Python SDK compiles and matches
 * them by the same rules, so one list of patterns means the same thing in both.
 */
import { isHealthCheck } from "../utils/health-check.js";
import { sdkLog } from "./diagnostics.js";

/** What a function given in `ignoreRoutes` is asked about: the request's method (upper case), path and route. */
export interface RouteInfo {
  method: string;
  /** The request path, without the query string. */
  path: string;
  /** The framework's route template (`/orders/:id`) when the framework has matched one by then. */
  route?: string;
}

/** What a function given in `ignoreUrls` is asked about: the outgoing call's method, URL, host and path. */
export interface UrlInfo {
  method: string;
  url: string;
  host: string;
  /** The URL's path, without the query string. */
  path: string;
}

export type RoutePattern = string | RegExp | ((info: RouteInfo) => boolean);
export type UrlPattern = string | RegExp | ((info: UrlInfo) => boolean);
export type FunctionPattern = string | RegExp | ((name: string) => boolean);

export interface IgnoreOptions {
  ignoreRoutes?: RoutePattern | RoutePattern[];
  ignoreUrls?: UrlPattern | UrlPattern[];
  ignoreFunctions?: FunctionPattern | FunctionPattern[];
  traceHealthChecks?: boolean;
}

interface Called<A> {
  kind: "fn";
  fn: (arg: A) => unknown;
  label: string;
  option: string;
  warned: boolean;
}

type RouteRule =
  | { kind: "glob"; method?: string; re: RegExp }
  | { kind: "regex"; re: RegExp }
  | Called<RouteInfo>;

interface UrlGlob {
  kind: "glob";
  scheme?: string;
  /** Undefined: any host. */
  host?: RegExp;
  /** Undefined: any port. */
  port?: string;
  /** Undefined: any path. */
  path?: RegExp;
}

type UrlRule = UrlGlob | { kind: "regex"; re: RegExp } | Called<UrlInfo>;

type FunctionRule = { kind: "regex"; re: RegExp } | Called<string>;

interface IgnoreState {
  routes: RouteRule[];
  urls: UrlRule[];
  functions: FunctionRule[];
  traceHealthChecks: boolean;
}

const EMPTY: IgnoreState = { routes: [], urls: [], functions: [], traceHealthChecks: false };

let state: IgnoreState = EMPTY;

const ENV_NAMES = {
  ignoreRoutes: "EVALKIT_IGNORE_ROUTES",
  ignoreUrls: "EVALKIT_IGNORE_URLS",
  ignoreFunctions: "EVALKIT_IGNORE_FUNCTIONS",
} as const;

type ListOption = keyof typeof ENV_NAMES;

// ── compiling ────────────────────────────────────────────────────────────────────────────────────────

const METHOD_RE = /^([A-Za-z]+|\*)\s+(\S.*)$/;
const PARAM_RE = /^(?::.+|\{[^/]*\}|<[^/]*>)$/;
const SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*|\*)$/;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function cutQuery(text: string): string {
  const end = text.search(/[?#]/);
  return end < 0 ? text : text.slice(0, end);
}

/** A path glob as one anchored expression over a normalized path (no trailing slash, root as ""). */
function pathSource(path: string): string {
  let src = "";
  for (const segment of cutQuery(path).split("/")) {
    if (!segment) continue;
    if (segment === "**") src += "(?:/[^/]+)*";
    else if (segment === "*" || PARAM_RE.test(segment)) src += "/[^/]+";
    else if (segment.includes("*")) src += "/" + segment.split("*").map(escapeRe).join("[^/]*");
    else src += "/" + escapeRe(segment);
  }
  return src;
}

/**
 * Dotted names (hosts, function names) as one anchored expression: `*` is one label, `**` any number of
 * labels including none, and a label with a `*` in it a glob within that label.
 */
function dottedSource(labels: string[]): string {
  let src = "";
  const last = labels.length - 1;
  labels.forEach((label, i) => {
    if (label === "**") {
      src += i === 0 ? "(?:[^.]+\\.)*" : i === last ? "(?:\\.[^.]+)*" : "\\.(?:[^.]+\\.)*";
      return;
    }
    const piece = label === "*"
      ? "[^.]+"
      : label.includes("*") ? label.split("*").map(escapeRe).join("[^.]*") : escapeRe(label);
    src += i === 0 || labels[i - 1] === "**" ? piece : "\\." + piece;
  });
  return src;
}

/** A RegExp the matcher may call `.test()` on repeatedly: a global or sticky one would remember its last match. */
function statelessRegExp(re: RegExp): RegExp {
  return re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re;
}

function describe(pattern: unknown): string {
  if (typeof pattern === "string") return JSON.stringify(pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern);
  if (pattern instanceof RegExp) return String(pattern);
  if (typeof pattern === "function") return `function ${(pattern as { name?: string }).name || "(anonymous)"}`;
  return pattern === null ? "null" : typeof pattern;
}

function called<A>(fn: (arg: A) => unknown, option: string): Called<A> {
  return { kind: "fn", fn, label: describe(fn), option, warned: false };
}

function compileRoute(pattern: string): RouteRule | string {
  let text = pattern.trim();
  if (!text) return "it is empty";
  let method: string | undefined;
  if (/\s/.test(text)) {
    const m = METHOD_RE.exec(text);
    if (!m) return 'expected "METHOD /path" or a path';
    method = m[1] === "*" ? undefined : m[1].toUpperCase();
    text = m[2].trim();
    if (/\s/.test(text)) return "a path has no spaces";
  }
  if (text.startsWith("*")) text = "/" + text;
  if (!text.startsWith("/")) return "a route pattern starts with / (or * / **)";
  return { kind: "glob", method, re: new RegExp(`^${pathSource(text)}$`) };
}

function compileUrl(pattern: string): UrlRule | string {
  let text = pattern.trim();
  if (!text) return "it is empty";
  if (/\s/.test(text)) return "a URL pattern has no spaces";
  const rule: UrlGlob = { kind: "glob" };
  const schemeEnd = text.indexOf("://");
  if (schemeEnd >= 0) {
    const scheme = text.slice(0, schemeEnd).toLowerCase();
    if (!SCHEME_RE.test(scheme)) return `${JSON.stringify(scheme)} is not a URL scheme`;
    if (scheme !== "*") rule.scheme = scheme;
    text = text.slice(schemeEnd + 3);
    if (!text || text.startsWith("/") || /^[?#]/.test(text)) return "it has a scheme but no host";
  }
  text = cutQuery(text);
  if (text.startsWith("/")) {
    rule.path = new RegExp(`^${pathSource(text)}$`);
    return rule;
  }
  const slash = text.indexOf("/");
  let authority = slash < 0 ? text : text.slice(0, slash);
  if (slash >= 0) rule.path = new RegExp(`^${pathSource(text.slice(slash))}$`);
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return "an IPv6 host is closed with ]";
    host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return "expected :port after the IPv6 host";
      port = rest.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }
  if (port !== undefined) {
    if (port !== "*" && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
      return `${JSON.stringify(port)} is not a port`;
    }
    if (port !== "*") rule.port = String(Number(port));
  }
  host = host.toLowerCase();
  if (!host) return "it has no host";
  if (host !== "*" && host !== "**") {
    if (host.startsWith("[")) {
      rule.host = new RegExp(`^${escapeRe(host)}$`);
    } else {
      const labels = host.split(".");
      if (labels.some((label) => !label)) return "a host has no empty labels";
      rule.host = new RegExp(`^${dottedSource(labels)}$`);
    }
  }
  return rule;
}

function compileFunction(pattern: string): FunctionRule | string {
  const text = pattern.trim();
  if (!text) return "it is empty";
  if (/\s/.test(text)) return "a function name has no spaces";
  const parts = text.split(".");
  if (parts.some((part) => !part)) return "a qualified name has no empty parts";
  return { kind: "regex", re: new RegExp(`^${dottedSource(parts)}$`) };
}

function asList(value: unknown, option: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" || value instanceof RegExp || typeof value === "function") return [value];
  sdkLog("warn", `[evalkit] ${option} must be a list of patterns (got ${describe(value)}); it is ignored`);
  return [];
}

function envList(name: string): string[] {
  try {
    const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
    if (!raw) return [];
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function compileList<R>(
  option: ListOption,
  given: unknown,
  fromString: (text: string) => R | string,
  fromRegExp: (re: RegExp) => R,
  fromFunction: (fn: (arg: any) => unknown, option: string) => R,
): R[] {
  const out: R[] = [];
  const sources: Array<[string, unknown[]]> = [
    [option, asList(given, option)],
    [ENV_NAMES[option], envList(ENV_NAMES[option])],
  ];
  for (const [source, items] of sources) {
    for (const item of items) {
      let compiled: R | string;
      try {
        if (typeof item === "string") compiled = fromString(item);
        else if (item instanceof RegExp) compiled = fromRegExp(statelessRegExp(item));
        else if (typeof item === "function") compiled = fromFunction(item as (arg: any) => unknown, source);
        else compiled = "a pattern is a string, a RegExp or a function";
      } catch (err) {
        compiled = err instanceof Error ? err.message : String(err);
      }
      if (typeof compiled === "string") {
        sdkLog("warn", `[evalkit] ${source}: skipped the invalid pattern ${describe(item)} (${compiled})`);
        continue;
      }
      out.push(compiled);
    }
  }
  return out;
}

/**
 * Compiles the ignore options of the client being made, with the EVALKIT_IGNORE_* variables appended, and puts
 * them in force for every instrumentation. An invalid pattern is skipped with one warning; nothing here throws.
 */
export function configureIgnore(options: IgnoreOptions | undefined): void {
  try {
    const o = options ?? {};
    state = {
      routes: compileList<RouteRule>("ignoreRoutes", o.ignoreRoutes, compileRoute, (re) => ({ kind: "regex", re }), (fn, option) => called(fn, option)),
      urls: compileList<UrlRule>("ignoreUrls", o.ignoreUrls, compileUrl, (re) => ({ kind: "regex", re }), (fn, option) => called(fn, option)),
      functions: compileList<FunctionRule>("ignoreFunctions", o.ignoreFunctions, compileFunction, (re) => ({ kind: "regex", re }), (fn, option) => called(fn, option)),
      traceHealthChecks: o.traceHealthChecks === true,
    };
  } catch {
    state = EMPTY;
  }
}

/** Back to nothing ignored but health probes. */
export function resetIgnore(): void {
  state = EMPTY;
}

// ── matching ─────────────────────────────────────────────────────────────────────────────────────────

const ORIGIN_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

/** A request target or URL's path, without the query string or fragment. */
function pathOnly(url: string): string {
  const origin = ORIGIN_RE.exec(url);
  const path = cutQuery(origin ? url.slice(origin[0].length) : url);
  return path.startsWith("/") || !path ? path : "/" + path;
}

/** The form globs are matched against: no repeated slashes and no trailing one; the root is "". */
function normalise(path: string): string {
  let p = path.includes("//") ? path.replace(/\/{2,}/g, "/") : path;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function warnOnce(rule: Called<unknown>, why: string): void {
  if (rule.warned) return;
  rule.warned = true;
  sdkLog("warn", `[evalkit] ${rule.option}: the pattern ${rule.label} ${why}; it counts as no match`);
}

/**
 * A pattern function's answer, read as true or false. The decision is needed before the request or call goes
 * on, so a promise (an async function) is no answer: being truthy, it would otherwise leave out everything.
 */
function ask<A>(rule: Called<A>, arg: A): boolean {
  try {
    const answer = rule.fn(arg);
    if (answer && typeof (answer as { then?: unknown }).then === "function") {
      warnOnce(rule as Called<unknown>, "returned a promise (a pattern function answers synchronously)");
      return false;
    }
    return !!answer;
  } catch (err) {
    warnOnce(rule as Called<unknown>, `threw (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/** Whether health probes are traced like any request (`traceHealthChecks: true`). */
export function healthChecksTraced(): boolean {
  return state.traceHealthChecks;
}

/** Whether `path` is a health probe the SDK leaves out (unless `traceHealthChecks` is on). */
export function isUntracedProbe(path: unknown): boolean {
  return !state.traceHealthChecks && isHealthCheck(path);
}

/**
 * Whether an inbound request is left out of tracing: a health probe (unless `traceHealthChecks`), or a request
 * an `ignoreRoutes` pattern matches. `url` is the request target or a full URL; `route` the framework's
 * template, when it has matched one by now.
 */
export function isIgnoredRequest(method: unknown, url: unknown, route?: unknown): boolean {
  try {
    const target = typeof url === "string" ? url : "";
    if (!state.traceHealthChecks && isHealthCheck(target)) return true;
    const rules = state.routes;
    if (!rules.length) return false;
    const verb = typeof method === "string" && method ? method.toUpperCase() : "";
    const path = pathOnly(target);
    const normal = normalise(path);
    const template = typeof route === "string" && route ? normalise(pathOnly(route)) : undefined;
    for (const rule of rules) {
      if (rule.kind === "glob") {
        if (rule.method !== undefined && rule.method !== verb) continue;
        if (rule.re.test(normal) || (template !== undefined && rule.re.test(template))) return true;
      } else if (rule.kind === "regex") {
        if (rule.re.test(path) || (normal !== path && rule.re.test(normal))) return true;
      } else {
        const info: RouteInfo = { method: verb, path };
        if (typeof route === "string" && route) info.route = route;
        if (ask(rule, info)) return true;
      }
    }
  } catch {
    // A request the SDK cannot read is traced as usual.
  }
  return false;
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", ws: "80", https: "443", wss: "443" };
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/;

interface ParsedUrl {
  scheme: string;
  host: string;
  port?: string;
  path: string;
}

function parseUrl(url: string): ParsedUrl {
  const m = URL_RE.exec(url);
  if (!m) return { scheme: "", host: "", path: pathOnly(url) };
  const scheme = m[1].toLowerCase();
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    host = close < 0 ? authority : authority.slice(0, close + 1);
    const rest = close < 0 ? "" : authority.slice(close + 1);
    if (rest.startsWith(":") && rest.length > 1) port = rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      if (colon < authority.length - 1) port = authority.slice(colon + 1);
    }
  }
  const effective = port !== undefined && /^\d+$/.test(port) ? String(Number(port)) : DEFAULT_PORTS[scheme];
  return { scheme, host: host.toLowerCase(), port: effective, path: cutQuery(m[3]) || "/" };
}

/** Whether an `ignoreUrls` pattern matches an outgoing call. Health probes are not decided here. */
export function matchesIgnoredUrl(url: unknown, method?: unknown): boolean {
  const rules = state.urls;
  if (!rules.length || typeof url !== "string" || !url) return false;
  try {
    let parsed: ParsedUrl | undefined;
    let normal: string | undefined;
    for (const rule of rules) {
      if (rule.kind === "regex") {
        if (rule.re.test(url)) return true;
        continue;
      }
      parsed ??= parseUrl(url);
      if (rule.kind === "fn") {
        const verb = typeof method === "string" && method ? method.toUpperCase() : "GET";
        if (ask(rule, { method: verb, url, host: parsed.host, path: parsed.path })) return true;
        continue;
      }
      if (rule.scheme !== undefined && rule.scheme !== parsed.scheme) continue;
      if (rule.host !== undefined && !rule.host.test(parsed.host)) continue;
      if (rule.port !== undefined && rule.port !== parsed.port) continue;
      if (rule.path !== undefined) {
        normal ??= normalise(parsed.path);
        if (!rule.path.test(normal)) continue;
      }
      return true;
    }
  } catch {
    // A URL the SDK cannot read is traced as usual.
  }
  return false;
}

/**
 * Whether an outgoing call is left out of tracing: a call to a health probe (unless `traceHealthChecks`), or
 * one an `ignoreUrls` pattern matches. Such a call creates no span and carries no traceparent.
 */
export function isIgnoredUrl(url: unknown, method?: unknown): boolean {
  if (!state.traceHealthChecks && isHealthCheck(url)) return true;
  return matchesIgnoredUrl(url, method);
}

/** Whether an `ignoreFunctions` pattern matches a function span's name. */
export function isIgnoredFunction(name: unknown): boolean {
  const rules = state.functions;
  if (!rules.length || typeof name !== "string" || !name) return false;
  try {
    for (const rule of rules) {
      if (rule.kind === "regex" ? rule.re.test(name) : ask(rule, name)) return true;
    }
  } catch {
    // A name the SDK cannot read is traced as usual.
  }
  return false;
}
