import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ENDPOINT = "https://api.syntropylabs.ai/v1/otlp";
const CONFIG_FILE = "config.env";
const STATE_FILE = "state.json";

export interface SharedConfig {
  endpoint: string;
  key: string;
  capture: "minimal" | "full";
  tenant: string;
}

export interface VendorRecord {
  scope: "user" | "project";
  files: Record<string, Record<string, unknown>>;
  capture?: "minimal" | "full";
  traces?: boolean;
}

export interface DoctorRecord {
  at: string;
  ok: boolean;
  detail: string;
}

export interface State {
  vendors: Record<string, VendorRecord>;
  doctor?: DoctorRecord;
}

export function maskKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export class ConfigStore {
  readonly home: string;
  readonly dir: string;

  constructor(home?: string) {
    this.home = home ?? homedir();
    this.dir = join(this.home, ".config", "evalkit");
  }

  load(): SharedConfig {
    const cfg: SharedConfig = { endpoint: DEFAULT_ENDPOINT, key: "", capture: "minimal", tenant: "" };
    const path = join(this.dir, CONFIG_FILE);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.includes("=") || line.trimStart().startsWith("#")) continue;
        const idx = line.indexOf("=");
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === "EVALKIT_OTLP_ENDPOINT") cfg.endpoint = value;
        else if (key === "EVALKIT_API_KEY") cfg.key = value;
        else if (key === "EVALKIT_CONTENT_CAPTURE" && (value === "minimal" || value === "full")) cfg.capture = value;
        else if (key === "EVALKIT_TENANT_ID") cfg.tenant = value;
      }
    }
    cfg.endpoint = process.env.EVALKIT_OTLP_ENDPOINT ?? cfg.endpoint;
    cfg.key = process.env.EVALKIT_API_KEY ?? cfg.key;
    const capture = process.env.EVALKIT_CONTENT_CAPTURE;
    if (capture === "minimal" || capture === "full") cfg.capture = capture;
    cfg.tenant = process.env.EVALKIT_TENANT_ID ?? cfg.tenant;
    return cfg;
  }

  save(cfg: SharedConfig): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, CONFIG_FILE);
    writeFileSync(path, `EVALKIT_OTLP_ENDPOINT=${cfg.endpoint}\nEVALKIT_API_KEY=${cfg.key}\nEVALKIT_CONTENT_CAPTURE=${cfg.capture}\nEVALKIT_TENANT_ID=${cfg.tenant}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  loadState(): State {
    const path = join(this.dir, STATE_FILE);
    if (!existsSync(path)) return { vendors: {} };
    const raw = JSON.parse(readFileSync(path, "utf8") || "{}") as Partial<State>;
    return { vendors: raw.vendors ?? {}, doctor: raw.doctor };
  }

  saveState(state: State): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, STATE_FILE);
    const body: Partial<State> = { vendors: state.vendors };
    if (state.doctor) body.doctor = state.doctor;
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  purge(): void {
    for (const name of [CONFIG_FILE, STATE_FILE]) {
      const path = join(this.dir, name);
      if (existsSync(path)) unlinkSync(path);
    }
    if (existsSync(this.dir) && readdirSync(this.dir).length === 0) rmdirSync(this.dir);
  }
}
