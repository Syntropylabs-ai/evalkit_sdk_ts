import { ConfigStore, maskKey, type DoctorRecord, type SharedConfig, type VendorRecord } from "./config.js";
import * as doctorRun from "./doctor.js";
import { MalformedFile } from "./files.js";
import { runHook } from "./hook.js";
import { ClaudeCodeInstaller, VENDORS, installerFor, type InstallOptions, type VendorStatus } from "./vendors.js";

export { shellWord } from "./vendors.js";
export { buildRecords } from "./hook.js";
export { events as hookEvents } from "./turns.js";
export { OPENCODE_PLUGIN_SOURCE, PLUGIN_SOURCE_SHA256 } from "../opencode/plugin.js";

const HOOK_VENDORS = ["claude-code", "cursor", "windsurf"] as const;

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
    } else flags[arg.slice(2)] = true;
  }
  return { positional, flags };
}

const USAGE = `usage:
  evalkit coding install --vendor <${VENDORS.join("|")}> --key <key> [--endpoint <url>] [--tenant <id>] [--scope user|project] [--capture minimal|full] [--no-traces] [--no-subagents (claude-code: write no hooks)] [--dry-run] [--managed]
  evalkit coding status
  evalkit coding doctor [--vendor <name>] [--tenant <id>]
  evalkit coding uninstall --vendor <name> [--purge] [--dry-run]
  evalkit coding hook --vendor ${HOOK_VENDORS.join("|")} --event <event>`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  home?: string;
  cwd?: string;
  binary?: string;
}

function str(flags: Parsed["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function requireVendor(flags: Parsed["flags"], io: CliIo, allowed: readonly string[] = VENDORS): string | null {
  const vendor = str(flags, "vendor");
  if (!vendor || !allowed.includes(vendor)) {
    io.err(`--vendor must be one of ${allowed.join(", ")}`);
    return null;
  }
  return vendor;
}

async function install(flags: Parsed["flags"], io: CliIo, store: ConfigStore): Promise<number> {
  const vendor = requireVendor(flags, io);
  if (!vendor) return 2;
  const cfg: SharedConfig = store.load();
  const key = str(flags, "key");
  const endpoint = str(flags, "endpoint");
  const capture = str(flags, "capture");
  const tenant = str(flags, "tenant");
  if (key) cfg.key = key;
  if (endpoint) cfg.endpoint = endpoint.replace(/\/$/, "");
  if (tenant) cfg.tenant = tenant;
  if (capture === "minimal" || capture === "full") cfg.capture = capture;
  else if (capture) {
    io.err("--capture must be minimal or full");
    return 2;
  }
  if (!cfg.key) {
    io.err("a subscription key is required: pass --key or set EVALKIT_API_KEY");
    return 2;
  }
  const scope = str(flags, "scope") ?? "user";
  if (scope !== "user" && scope !== "project") {
    io.err("--scope must be user or project");
    return 2;
  }
  const opts: InstallOptions = {
    scope,
    capture: cfg.capture,
    traces: flags["no-traces"] !== true,
    dryRun: flags["dry-run"] === true,
    subagents: flags["no-subagents"] !== true,
    cwd: io.cwd ?? process.cwd(),
  };
  const installer = installerFor(vendor, store.home, io.binary ?? "evalkit");
  if (flags.managed === true && installer instanceof ClaudeCodeInstaller) {
    io.out(JSON.stringify(installer.managedSnippet(cfg, opts), null, 2));
    return 0;
  }
  const saved = store.loadState();
  let result;
  try {
    result = installer.install(cfg, opts, saved.vendors[vendor]);
  } catch (error) {
    if (error instanceof MalformedFile || error instanceof Error) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
  const prefix = opts.dryRun ? "would write" : "wrote";
  for (const change of result.changes) io.out(`${prefix} ${change.path}: ${change.summary}`);
  if (!opts.dryRun) {
    store.save(cfg);
    saved.vendors[vendor] = result.state;
    store.saveState(saved);
    io.out(`${vendor} connected to ${cfg.endpoint} (key ${maskKey(cfg.key)})`);
  }
  return 0;
}

function uninstall(flags: Parsed["flags"], io: CliIo, store: ConfigStore): number {
  const vendor = requireVendor(flags, io);
  if (!vendor) return 2;
  const dryRun = flags["dry-run"] === true;
  const saved = store.loadState();
  const entry: VendorRecord | undefined = saved.vendors[vendor];
  if (!entry) io.out(`${vendor} is not installed`);
  else {
    const changes = installerFor(vendor, store.home, io.binary ?? "evalkit").uninstall(entry, dryRun);
    for (const change of changes) io.out(`${dryRun ? "would update" : "updated"} ${change.path}: ${change.summary}`);
    if (!dryRun) {
      delete saved.vendors[vendor];
      store.saveState(saved);
    }
  }
  if (flags.purge === true && !dryRun && Object.keys(saved.vendors).length === 0) {
    store.purge();
    io.out("removed shared evalkit config");
  }
  return 0;
}

function hookSummary(state: VendorStatus): string {
  const events = state.hooks ?? [];
  if (state.subagents !== undefined) {
    const listed = events.length && state.subagents ? ` (${events.join(", ")})` : "";
    return ` · agent hooks: ${state.subagents ? "on" : "off"}${listed}`;
  }
  return events.length ? ` · hooks: ${events.length} events` : "";
}

function doctorLine(entry?: DoctorRecord): string {
  if (!entry) return "never run";
  return `${entry.ok ? "ok" : "failed"} at ${entry.at} (${entry.detail})`;
}

function vendorLine(vendor: string, state: VendorStatus): string {
  const detail = `capture ${state.capture} · traces ${state.traces ? "on" : "off"}${hookSummary(state)}`;
  const files = Object.entries(state.files ?? {}).map(([path, present]) => `${path}${present ? "" : " (missing)"}`).join(", ");
  return `${vendor}: installed (${state.scope}) · ${detail} → ${files}`;
}

function status(io: CliIo, store: ConfigStore): number {
  const cfg = store.load();
  const saved = store.loadState();
  io.out(`endpoint: ${cfg.endpoint}`);
  io.out(`key: ${maskKey(cfg.key)}`);
  io.out(`content capture: ${cfg.capture}`);
  io.out(`last doctor: ${doctorLine(saved.doctor)}`);
  for (const vendor of VENDORS) {
    const state = installerFor(vendor, store.home, io.binary ?? "evalkit").status(saved.vendors[vendor]);
    if (!state.installed) {
      io.out(`${vendor}: not installed`);
      continue;
    }
    io.out(vendorLine(vendor, state));
  }
  return 0;
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function doctor(flags: Parsed["flags"], io: CliIo, store: ConfigStore): Promise<number> {
  const cfg = store.load();
  if (!cfg.key) {
    io.err("no key configured; run `evalkit coding install` first");
    return 2;
  }
  const saved = store.loadState();
  const { ok, detail } = await doctorRun.run(cfg, str(flags, "tenant") ?? cfg.tenant ?? undefined);
  io.out(`round trip: ${ok ? "ok" : "failed"} (${detail}) → exporter ${cfg.endpoint}`);
  saved.doctor = { at: timestamp(), ok, detail };
  store.saveState(saved);
  const only = str(flags, "vendor");
  const vendors = only ? [only] : VENDORS.filter((v) => v in saved.vendors);
  for (const vendor of vendors) {
    const state = installerFor(vendor, store.home, io.binary ?? "evalkit").status(saved.vendors[vendor]);
    if (!state.installed) {
      io.out(`${vendor}: not installed`);
      continue;
    }
    io.out(`${vendor}: installed (${state.scope}) · capture ${state.capture} · traces ${state.traces ? "on" : "off"}${hookSummary(state)}`);
  }
  if (!vendors.length) io.out("nothing installed yet");
  return ok ? 0 : 1;
}

export async function main(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const store = new ConfigStore(io.home);
  if (positional[0] !== "coding") {
    io.err(USAGE);
    return 2;
  }
  switch (positional[1]) {
    case "install":
      return install(flags, io, store);
    case "uninstall":
      return uninstall(flags, io, store);
    case "status":
      return status(io, store);
    case "doctor":
      return doctor(flags, io, store);
    case "hook": {
      const vendor = requireVendor(flags, { ...io, err: () => undefined }, HOOK_VENDORS);
      const event = str(flags, "event");
      if (!vendor || !event) return 0;
      return runHook(vendor, event, io.home);
    }
    default:
      io.err(USAGE);
      return 2;
  }
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
