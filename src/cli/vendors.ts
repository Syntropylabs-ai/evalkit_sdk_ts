import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SharedConfig, VendorRecord } from "./config.js";
import { deleteNested, getNested, hasTomlTableOutside, readJson, replaceMarkerBlock, setNested, writeAtomic, writeJson, type JsonObject } from "./files.js";
import { PLUGIN_FILE_NAME, OPENCODE_PLUGIN_SOURCE } from "../opencode/plugin.js";
import { events as hookEventsFor } from "./turns.js";

export const VENDORS = ["claude-code", "codex", "gemini-cli", "cursor", "windsurf", "opencode"] as const;
export type Vendor = (typeof VENDORS)[number];

const TOML_BEGIN = "# evalkit-managed-begin";
const TOML_END = "# evalkit-managed-end";
const ENV_BEGIN = "# evalkit-begin";
const ENV_END = "# evalkit-end";

export interface InstallOptions {
  scope: "user" | "project";
  capture: "minimal" | "full";
  traces: boolean;
  dryRun: boolean;
  subagents: boolean;
  cwd: string;
}

export interface Change {
  path: string;
  summary: string;
}

export interface VendorInstaller {
  readonly name: Vendor;
  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord): { state: VendorRecord; changes: Change[] };
  uninstall(state: VendorRecord, dryRun: boolean): Change[];
  status(state?: VendorRecord): VendorStatus;
}

export interface VendorStatus {
  installed: boolean;
  scope?: string;
  capture?: string;
  traces?: boolean;
  hooks?: string[];
  files?: Record<string, boolean>;
  subagents?: boolean;
}

function statusOf(state?: VendorRecord): VendorStatus {
  if (!state) return { installed: false };
  const hooks: string[] = [];
  for (const info of Object.values(state.files)) hooks.push(...((info.hookEvents as string[] | undefined) ?? []));
  return {
    installed: true,
    scope: state.scope,
    capture: state.capture ?? "minimal",
    traces: state.traces ?? false,
    hooks,
    files: Object.fromEntries(Object.keys(state.files).map((p) => [p, existsSync(p)])),
  };
}

function vendorState(opts: InstallOptions, files: VendorRecord["files"]): VendorRecord {
  return { scope: opts.scope, files, capture: opts.capture, traces: opts.traces };
}

export function shellWord(text: string): string {
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function ownedHook(marker: string, hook: unknown): boolean {
  return Boolean(hook) && typeof hook === "object" && String((hook as JsonObject).command ?? "").includes(marker);
}

function carryFiles(existing: VendorRecord | undefined, written: VendorRecord["files"]): VendorRecord["files"] {
  return { ...(existing?.files ?? {}), ...written };
}

abstract class JsonKeysInstaller implements VendorInstaller {
  abstract readonly name: Vendor;
  protected abstract readonly toolDir: string;
  protected abstract prefix(): string[];
  protected abstract keys(cfg: SharedConfig, opts: InstallOptions): Record<string, unknown>;

  constructor(protected readonly home: string) {}

  protected target(opts: InstallOptions): string {
    return join(opts.scope === "project" ? opts.cwd : this.home, this.toolDir, "settings.json");
  }

  protected mergeExtra(_data: JsonObject, _opts: InstallOptions, _info: JsonObject): string[] {
    return [];
  }

  protected restoreExtra(_data: JsonObject, _info: JsonObject): string[] {
    return [];
  }

  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord): { state: VendorRecord; changes: Change[] } {
    const path = this.target(opts);
    const data = readJson(path);
    const desired = this.keys(cfg, opts);
    const remembered = (existing?.files[path] ?? {}) as { keys?: string[]; previous?: Record<string, unknown> };
    const owned = new Set(remembered.keys ?? []);
    const previous: Record<string, unknown> = { ...(remembered.previous ?? {}) };
    for (const [key, value] of Object.entries(desired)) {
      const { found, value: old } = getNested(data, [...this.prefix(), key]);
      if (found && !owned.has(key)) previous[key] = old;
      setNested(data, [...this.prefix(), key], value);
    }
    for (const key of [...owned].filter((name) => !(name in desired)).sort()) {
      deleteNested(data, [...this.prefix(), key]);
      if (key in previous) {
        setNested(data, [...this.prefix(), key], previous[key]);
        delete previous[key];
      }
    }
    const keys = Object.keys(desired).sort();
    const info: JsonObject = { keys, previous, prefix: this.prefix() };
    const summary = [`set ${Object.keys(desired).length} keys under ${this.prefix().join(".")}`, ...this.mergeExtra(data, opts, info)];
    if (!opts.dryRun) writeJson(path, data);
    return { state: vendorState(opts, carryFiles(existing, { [path]: info })), changes: [{ path, summary: summary.join("; ") }] };
  }

  uninstall(state: VendorRecord, dryRun: boolean): Change[] {
    const changes: Change[] = [];
    for (const [path, info] of Object.entries(state.files)) {
      if (!("keys" in info) || !existsSync(path)) continue;
      const data = readJson(path);
      const prefix = (info.prefix as string[] | undefined) ?? this.prefix();
      for (const key of (info.keys as string[]) ?? []) deleteNested(data, [...prefix, key]);
      for (const [key, old] of Object.entries((info.previous as Record<string, unknown>) ?? {})) setNested(data, [...prefix, key], old);
      const summary = [`removed ${((info.keys as string[]) ?? []).length} keys`, ...this.restoreExtra(data, info as JsonObject)];
      if (!dryRun) writeJson(path, data);
      changes.push({ path, summary: summary.join("; ") });
    }
    return changes;
  }

  status(state?: VendorRecord) {
    return statusOf(state);
  }
}

export const CLAUDE_HOOK_EVENTS = ["PostToolUse", "SubagentStop"] as const;
const CLAUDE_HOOK_TIMEOUT_S = 5;

export class ClaudeCodeInstaller extends JsonKeysInstaller {
  readonly name = "claude-code" as const;
  protected readonly toolDir = ".claude";

  constructor(home: string, private readonly binary: string) {
    super(home);
  }

  protected prefix(): string[] {
    return ["env"];
  }

  private marker(): string {
    return `coding hook --vendor ${this.name}`;
  }

  private hookGroup(event: string): JsonObject {
    return { hooks: [{ type: "command", command: `${this.binary} coding hook --vendor ${this.name} --event ${event}`, timeout: CLAUDE_HOOK_TIMEOUT_S }] };
  }

  private withoutOurs(groups: unknown, marker: string): { kept: unknown[]; removed: number } {
    const kept: unknown[] = [];
    let removed = 0;
    for (const group of Array.isArray(groups) ? groups : []) {
      const inner = group && typeof group === "object" ? (group as JsonObject).hooks : undefined;
      if (!Array.isArray(inner)) {
        kept.push(group);
        continue;
      }
      const rest = inner.filter((h) => !ownedHook(marker, h));
      removed += inner.length - rest.length;
      if (rest.length) kept.push({ ...(group as JsonObject), hooks: rest });
    }
    return { kept, removed };
  }

  private stripHooks(data: JsonObject, marker: string): number {
    const hooks = data.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return 0;
    const table = hooks as JsonObject;
    let removed = 0;
    for (const event of Object.keys(table)) {
      const current = table[event];
      if (!Array.isArray(current)) continue;
      const { kept, removed: gone } = this.withoutOurs(current, marker);
      if (!gone) continue;
      removed += gone;
      if (kept.length) table[event] = kept;
      else delete table[event];
    }
    if (!Object.keys(table).length) delete data.hooks;
    return removed;
  }

  protected override mergeExtra(data: JsonObject, opts: InstallOptions, info: JsonObject): string[] {
    if (!opts.subagents) {
      const removed = this.stripHooks(data, this.marker());
      return removed ? [`removed ${removed} agent hooks`] : [];
    }
    this.stripHooks(data, this.marker());
    const hooks = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : {}) as JsonObject;
    data.hooks = hooks;
    for (const event of CLAUDE_HOOK_EVENTS) {
      const current = hooks[event];
      if (current !== undefined && current !== null && !Array.isArray(current)) {
        throw new Error(`hooks.${event} in the settings file must be a list of hook groups; fix it before installing`);
      }
      hooks[event] = [...(Array.isArray(current) ? current : []), this.hookGroup(event)];
    }
    info.hookEvents = [...CLAUDE_HOOK_EVENTS];
    info.marker = this.marker();
    return [`merged ${CLAUDE_HOOK_EVENTS.length} agent hooks`];
  }

  protected override restoreExtra(data: JsonObject, info: JsonObject): string[] {
    if (!("hookEvents" in info)) return [];
    return [`removed ${this.stripHooks(data, (info.marker as string | undefined) ?? this.marker())} agent hooks`];
  }

  override status(state?: VendorRecord): VendorStatus {
    const result = statusOf(state);
    if (state) result.subagents = Object.values(state.files).some((info) => "hookEvents" in info);
    return result;
  }

  protected keys(cfg: SharedConfig, opts: InstallOptions): Record<string, unknown> {
    const env: Record<string, string> = {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: cfg.endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${cfg.key}`,
      OTEL_RESOURCE_ATTRIBUTES: "evalkit.vendor=claude-code",
      OTEL_LOGS_EXPORT_INTERVAL: "5000",
    };
    if (opts.traces) {
      env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
      env.OTEL_TRACES_EXPORTER = "otlp";
      env.OTEL_TRACES_EXPORT_INTERVAL = "1000";
    }
    if (opts.capture === "full") {
      env.OTEL_LOG_USER_PROMPTS = "1";
      env.OTEL_LOG_ASSISTANT_RESPONSES = "1";
      env.OTEL_LOG_TOOL_DETAILS = "1";
      env.OTEL_LOG_TOOL_CONTENT = "1";
      env.OTEL_LOG_RAW_API_BODIES = "1";
      env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = "524288";
    }
    return env;
  }

  managedSnippet(cfg: SharedConfig, opts: InstallOptions): JsonObject {
    const env = this.keys(cfg, opts) as Record<string, string>;
    env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer <EVALKIT_KEY>";
    return { env };
  }
}

export class GeminiCliInstaller extends JsonKeysInstaller {
  readonly name = "gemini-cli" as const;
  protected readonly toolDir = ".gemini";

  protected prefix(): string[] {
    return ["telemetry"];
  }

  protected keys(cfg: SharedConfig, opts: InstallOptions): Record<string, unknown> {
    return { enabled: true, target: "local", otlpEndpoint: cfg.endpoint, otlpProtocol: "http", logPrompts: opts.capture === "full", traces: opts.traces };
  }

  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord) {
    const result = super.install(cfg, opts, existing);
    const envPath = join(this.target(opts), "..", ".env");
    const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!opts.dryRun) writeAtomic(envPath, replaceMarkerBlock(text, ENV_BEGIN, ENV_END, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${cfg.key}`), 0o600);
    result.state.files = carryFiles(existing, { ...result.state.files, [envPath]: { block: [ENV_BEGIN, ENV_END] } });
    result.changes.push({ path: envPath, summary: "wrote OTEL_EXPORTER_OTLP_HEADERS between evalkit markers" });
    return result;
  }

  uninstall(state: VendorRecord, dryRun: boolean): Change[] {
    const changes: Change[] = [];
    for (const [path, info] of Object.entries(state.files)) {
      if ("block" in info && existsSync(path)) {
        const [begin, end] = info.block as [string, string];
        if (!dryRun) writeAtomic(path, replaceMarkerBlock(readFileSync(path, "utf8"), begin, end, null));
        changes.push({ path, summary: "removed evalkit marker block" });
      }
    }
    return [...changes, ...super.uninstall(state, dryRun)];
  }
}

export class CodexInstaller implements VendorInstaller {
  readonly name = "codex" as const;

  constructor(private readonly home: string) {}

  private target(opts: InstallOptions): string {
    return join(opts.scope === "project" ? opts.cwd : this.home, ".codex", "config.toml");
  }

  private block(cfg: SharedConfig, opts: InstallOptions): string {
    const endpoint = cfg.endpoint.replace(/\/$/, "");
    const exporter = (signal: string) => `{ otlp-http = { endpoint = "${endpoint}/v1/${signal}", protocol = "binary", headers = { "Authorization" = "Bearer ${cfg.key}" } } }`;
    return [
      "[otel]",
      'environment = "prod"',
      `log_user_prompt = ${opts.capture === "full" ? "true" : "false"}`,
      `exporter = ${exporter("logs")}`,
      `trace_exporter = ${opts.traces ? exporter("traces") : '"none"'}`,
      `metrics_exporter = ${exporter("metrics")}`,
    ].join("\n");
  }

  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord) {
    const path = this.target(opts);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (hasTomlTableOutside(text, "otel", TOML_BEGIN, TOML_END)) throw new Error(`${path} already has an [otel] table outside the evalkit markers; remove or move it first`);
    if (!opts.dryRun) writeAtomic(path, replaceMarkerBlock(text, TOML_BEGIN, TOML_END, this.block(cfg, opts)), 0o600);
    return { state: vendorState(opts, carryFiles(existing, { [path]: { block: [TOML_BEGIN, TOML_END] } })), changes: [{ path, summary: "wrote [otel] block between evalkit markers" }] };
  }

  uninstall(state: VendorRecord, dryRun: boolean): Change[] {
    const changes: Change[] = [];
    for (const [path, info] of Object.entries(state.files)) {
      if (!existsSync(path)) continue;
      const [begin, end] = info.block as [string, string];
      if (!dryRun) writeAtomic(path, replaceMarkerBlock(readFileSync(path, "utf8"), begin, end, null));
      changes.push({ path, summary: "removed [otel] block" });
    }
    return changes;
  }

  status(state?: VendorRecord) {
    return statusOf(state);
  }
}

abstract class HooksInstaller implements VendorInstaller {
  abstract readonly name: Vendor;
  protected abstract readonly userPath: string[];
  protected abstract readonly projectPath: string[];
  protected abstract readonly events: readonly string[];
  protected readonly versioned: boolean = false;
  protected readonly timeoutMs: number | null = null;

  constructor(protected readonly home: string, private readonly binary: string) {}

  private target(opts: InstallOptions): string {
    return opts.scope === "project" ? join(opts.cwd, ...this.projectPath) : join(this.home, ...this.userPath);
  }

  private marker(): string {
    return `coding hook --vendor ${this.name}`;
  }

  private entry(event: string): JsonObject {
    const item: JsonObject = { command: `${this.binary} coding hook --vendor ${this.name} --event ${event}` };
    if (this.timeoutMs !== null) item.timeout = this.timeoutMs;
    return item;
  }

  private strip(data: JsonObject, marker: string): number {
    const hooks = data.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return 0;
    const table = hooks as JsonObject;
    let removed = 0;
    for (const event of Object.keys(table)) {
      const entries = table[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((h) => !ownedHook(marker, h));
      if (kept.length === entries.length) continue;
      removed += entries.length - kept.length;
      if (kept.length) table[event] = kept;
      else delete table[event];
    }
    if (!Object.keys(table).length) delete data.hooks;
    return removed;
  }

  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord) {
    const path = this.target(opts);
    const data = readJson(path);
    if (this.versioned && data.version === undefined) data.version = 1;
    const table = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : {}) as JsonObject;
    for (const event of this.events) {
      const current = table[event];
      if (current !== undefined && current !== null && !Array.isArray(current)) {
        throw new Error(`hooks.${event} in ${path} must be a list of hook entries; fix it before installing`);
      }
    }
    this.strip(data, this.marker());
    const hooks = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks) ? data.hooks : {}) as JsonObject;
    data.hooks = hooks;
    for (const event of this.events) {
      const current = hooks[event];
      hooks[event] = [...(Array.isArray(current) ? current : []), this.entry(event)];
    }
    if (!opts.dryRun) writeJson(path, data);
    return { state: vendorState(opts, carryFiles(existing, { [path]: { hookEvents: [...this.events], marker: this.marker() } })), changes: [{ path, summary: `merged ${this.events.length} hook events` }] };
  }

  uninstall(state: VendorRecord, dryRun: boolean): Change[] {
    const changes: Change[] = [];
    for (const [path, info] of Object.entries(state.files)) {
      if (!existsSync(path)) continue;
      const data = readJson(path);
      this.strip(data, (info.marker as string | undefined) ?? this.marker());
      if (!dryRun) writeJson(path, data);
      changes.push({ path, summary: "removed evalkit hook entries" });
    }
    return changes;
  }

  status(state?: VendorRecord) {
    return statusOf(state);
  }
}

export class CursorInstaller extends HooksInstaller {
  readonly name = "cursor" as const;
  protected readonly userPath = [".cursor", "hooks.json"];
  protected readonly projectPath = [".cursor", "hooks.json"];
  protected override readonly versioned: boolean = true;
  protected override readonly timeoutMs: number | null = 5000;
  protected readonly events = hookEventsFor("cursor");
}

export class WindsurfInstaller extends HooksInstaller {
  readonly name = "windsurf" as const;
  protected readonly userPath = [".codeium", "windsurf", "hooks.json"];
  protected readonly projectPath = [".windsurf", "hooks.json"];
  protected readonly events = hookEventsFor("windsurf");
}

export class OpenCodeInstaller implements VendorInstaller {
  readonly name = "opencode" as const;
  private readonly arrayKey = "plugin";

  constructor(private readonly home: string) {}

  private targets(opts: InstallOptions): { configPath: string; pluginPath: string; reference: string } {
    if (opts.scope === "project") {
      return {
        configPath: join(opts.cwd, "opencode.json"),
        pluginPath: join(opts.cwd, ".opencode", "plugins", PLUGIN_FILE_NAME),
        reference: `./.opencode/plugins/${PLUGIN_FILE_NAME}`,
      };
    }
    const base = join(this.home, ".config", "opencode");
    return { configPath: join(base, "opencode.json"), pluginPath: join(base, "plugins", PLUGIN_FILE_NAME), reference: `./plugins/${PLUGIN_FILE_NAME}` };
  }

  install(cfg: SharedConfig, opts: InstallOptions, existing?: VendorRecord) {
    const { configPath, pluginPath, reference } = this.targets(opts);
    const data = readJson(configPath);
    const entries = data[this.arrayKey];
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
      throw new Error(`${configPath} has a non-list "${this.arrayKey}" value; fix it before installing`);
    }
    const kept = Array.isArray(entries) ? entries.filter((entry) => entry !== reference) : [];
    data[this.arrayKey] = [...kept, reference];
    if (!opts.dryRun) {
      writeJson(configPath, data);
      writeAtomic(pluginPath, OPENCODE_PLUGIN_SOURCE, 0o644);
    }
    const files: VendorRecord["files"] = {
      [configPath]: { arrayKey: this.arrayKey, value: reference },
      [pluginPath]: { file: true },
    };
    const changes: Change[] = [
      { path: configPath, summary: `registered ${reference} in "${this.arrayKey}"` },
      { path: pluginPath, summary: "wrote the evalkit OpenCode plugin" },
    ];
    return { state: vendorState(opts, carryFiles(existing, files)), changes };
  }

  uninstall(state: VendorRecord, dryRun: boolean): Change[] {
    const changes: Change[] = [];
    for (const [path, info] of Object.entries(state.files)) {
      if (!existsSync(path)) continue;
      if (info.file) {
        if (!dryRun) {
          unlinkSync(path);
          if (!readdirSync(dirname(path)).length) rmdirSync(dirname(path));
        }
        changes.push({ path, summary: "removed the evalkit OpenCode plugin" });
        continue;
      }
      const key = info.arrayKey as string;
      const value = info.value;
      const data = readJson(path);
      const entries = data[key];
      if (Array.isArray(entries)) {
        const kept = entries.filter((entry) => entry !== value);
        if (kept.length) data[key] = kept;
        else delete data[key];
      }
      if (!dryRun) writeJson(path, data);
      changes.push({ path, summary: `removed ${value} from "${key}"` });
    }
    return changes;
  }

  status(state?: VendorRecord) {
    return statusOf(state);
  }
}

export function installerFor(vendor: string, home: string, binary: string): VendorInstaller {
  switch (vendor) {
    case "claude-code":
      return new ClaudeCodeInstaller(home, binary);
    case "codex":
      return new CodexInstaller(home);
    case "gemini-cli":
      return new GeminiCliInstaller(home);
    case "cursor":
      return new CursorInstaller(home, binary);
    case "windsurf":
      return new WindsurfInstaller(home, binary);
    case "opencode":
      return new OpenCodeInstaller(home);
    default:
      throw new Error(`unknown vendor ${JSON.stringify(vendor)}; choose from ${VENDORS.join(", ")}`);
  }
}
