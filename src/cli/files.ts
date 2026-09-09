import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class MalformedFile extends Error {}

export type JsonObject = Record<string, unknown>;

export function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new MalformedFile(`${path} is not valid JSON (${(error as Error).message}); fix it before installing`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new MalformedFile(`${path} must contain a JSON object`);
  return data as JsonObject;
}

export function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpDir = mkdtempSync(join(dirname(path), `.${basename(path)}.`));
  const tmp = join(tmpDir, "next");
  try {
    writeFileSync(tmp, text);
    if (mode !== undefined) chmodSync(tmp, mode);
    else if (existsSync(path)) chmodSync(tmp, statSync(path).mode & 0o777);
    renameSync(tmp, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function writeJson(path: string, data: JsonObject): void {
  writeAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

export function setNested(data: JsonObject, keys: string[], value: unknown): void {
  let cursor = data;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as JsonObject;
  }
  cursor[keys[keys.length - 1]] = value;
}

export function getNested(data: JsonObject, keys: string[]): { found: boolean; value: unknown } {
  let cursor: unknown = data;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in (cursor as JsonObject))) return { found: false, value: undefined };
    cursor = (cursor as JsonObject)[key];
  }
  return { found: true, value: cursor };
}

export function deleteNested(data: JsonObject, keys: string[]): void {
  const parents: JsonObject[] = [];
  let cursor: unknown = data;
  for (const key of keys.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || !(key in (cursor as JsonObject))) return;
    parents.push(cursor as JsonObject);
    cursor = (cursor as JsonObject)[key];
  }
  if (cursor && typeof cursor === "object") delete (cursor as JsonObject)[keys[keys.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const child = parents[i][keys[i]];
    if (child && typeof child === "object" && Object.keys(child as JsonObject).length === 0) delete parents[i][keys[i]];
  }
}

export function replaceMarkerBlock(text: string, begin: string, end: string, block: string | null): string {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let start = -1, stop = -1;
  lines.forEach((line, index) => {
    if (line.trim() === begin && start < 0) start = index;
    else if (line.trim() === end && start >= 0 && stop < 0) stop = index;
  });
  if (start >= 0 && stop >= 0) {
    lines.splice(start, stop - start + 1);
    if (start > 0 && lines[start - 1].trim() === "" && (start >= lines.length || lines[start].trim() === "")) lines.splice(start - 1, 1);
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (block !== null) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(begin, ...block.split("\n"), end);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function hasTomlTableOutside(text: string, table: string, begin: string, end: string): boolean {
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === begin) inside = true;
    else if (stripped === end) inside = false;
    else if (!inside && stripped.startsWith(`[${table}]`)) return true;
  }
  return false;
}
