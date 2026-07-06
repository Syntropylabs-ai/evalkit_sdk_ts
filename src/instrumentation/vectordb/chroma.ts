import type { EvalKitClient } from "../../core/client.js";
import { safeBody, startVectorDb } from "./_common.js";

// Patch chromadb's collection query/add/upsert.
//
// The `chromadb` package (v3+) does NOT export its main `CollectionImpl` class —
// only `CollectionHandle` (a lightweight subclass returned by `client.collection(id)`)
// is public. `CollectionHandle extends CollectionImpl` but only overrides
// add/update/upsert, not query. We reach the shared base prototype via
// `Object.getPrototypeOf(CollectionHandle.prototype)`, which IS the real
// `CollectionImpl.prototype` object used by every collection instance
// (getCollection/createCollection/getOrCreateCollection all return CollectionImpl
// directly) — patching it there covers those, and patching CollectionHandle's own
// overridden add/upsert covers collections obtained via `client.collection(id)`.
//
// Never captures raw embeddings — only ids/distances and counts.

function ownMethod(proto: any, name: string): boolean {
  return !!proto && Object.prototype.hasOwnProperty.call(proto, name) && typeof proto[name] === "function";
}

export function patchChromaCollection(client: EvalKitClient, mod: any): void {
  const CollectionHandle = mod?.CollectionHandle;
  if (!CollectionHandle?.prototype) return;

  const baseProto = Object.getPrototypeOf(CollectionHandle.prototype);
  for (const proto of [baseProto, CollectionHandle.prototype]) {
    if (!proto) continue;
    if (ownMethod(proto, "query")) patchQuery(client, proto);
    if (ownMethod(proto, "add")) patchAddOrUpsert(client, proto, "add");
    if (ownMethod(proto, "upsert")) patchAddOrUpsert(client, proto, "upsert");
  }
}

function flattenMatches(result: any): Array<{ id: any; distance: any }> {
  const out: Array<{ id: any; distance: any }> = [];
  try {
    const ids: any[][] = result?.ids ?? [];
    const distances: any[][] = result?.distances ?? [];
    ids.forEach((batchIds, bi) => {
      const batchDistances = distances[bi] ?? [];
      batchIds.forEach((id, i) => out.push({ id, distance: batchDistances[i] ?? null }));
    });
  } catch { /* ignore */ }
  return out;
}

function patchQuery(client: EvalKitClient, proto: any): void {
  if (proto.query.__evalkit) return;
  const original = proto.query;

  proto.query = async function (this: any, args: any = {}) {
    const collectionName = this?.name;
    const end = startVectorDb(client, "chroma", "query");
    let result: any;
    try {
      result = await original.call(this, args);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const matches = flattenMatches(result);
    const attrs: Record<string, string | number | boolean> = {
      "db.vector.match_count": matches.length,
    };
    if (collectionName) attrs["db.vector.collection"] = collectionName;
    if (typeof args?.nResults === "number") attrs["db.vector.top_k"] = args.nResults;
    const reqBody = safeBody({ ...args, queryEmbeddings: undefined });
    if (reqBody) attrs["gen_ai.request.body"] = reqBody;
    const respBody = safeBody({ matches });
    if (respBody) attrs["gen_ai.response.body"] = respBody;
    end("OK", attrs);
    return result;
  };
  proto.query.__evalkit = true;
}

function patchAddOrUpsert(client: EvalKitClient, proto: any, method: "add" | "upsert"): void {
  if (proto[method].__evalkit) return;
  const original = proto[method];

  proto[method] = async function (this: any, args: any = {}) {
    const collectionName = this?.name;
    const end = startVectorDb(client, "chroma", method);
    let result: any;
    try {
      result = await original.call(this, args);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const attrs: Record<string, string | number | boolean> = {};
    if (collectionName) attrs["db.vector.collection"] = collectionName;
    if (Array.isArray(args?.ids)) attrs["db.vector.count"] = args.ids.length;
    end("OK", attrs);
    return result;
  };
  proto[method].__evalkit = true;
}
