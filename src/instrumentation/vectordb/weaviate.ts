import type { EvalKitClient } from "../../core/client.js";
import { safeBody, startVectorDb } from "./_common.js";

// Patch weaviate-client's near-vector query + insert/insertMany.
//
// weaviate-client's package.json `exports` map only exposes the top-level index —
// the actual query/data implementation classes (QueryManager, Searcher, ...) live
// under internal subpaths Node's module resolution blocks entirely, and aren't
// re-exported. So instead of class-level patching we wrap the real entry points
// (connectToLocal/connectToWeaviateCloud/connectToCustom/connectToWCS/connectToWCD),
// and on each resolved client, wrap `collections.get`/`.use` so every returned
// Collection's `.query.nearVector` and `.data.insert`/`.insertMany` get wrapped on
// that specific instance. This is the same "wrap the returned object" pattern used
// for the Gemini Live / OpenAI Realtime session wrappers.
//
// Auto-patching only works when the module object is mutable — true for a CJS
// `require("weaviate-client")` result, but NOT for a real ESM `import * as weaviate
// from "weaviate-client"` / `await import(...)` namespace object, which the spec
// makes read-only (assigning a property throws). In that case `patchWeaviateModule`
// silently no-ops (never throws into the caller) and `patchWeaviateClientInstance`
// is the fallback: call it manually on the client YOU already got back from
// `connectToLocal()`/etc., e.g. `const wc = await connectToLocal(); patchWeaviateClientInstance(client, wc);`.
//
// Never captures object `properties` (may hold full document text) or raw
// vectors — only ids and distance/certainty/score metadata.

const CONNECT_FNS = ["connectToLocal", "connectToWeaviateCloud", "connectToCustom", "connectToWCS", "connectToWCD"] as const;

export function patchWeaviateModule(client: EvalKitClient, mod: any): void {
  if (!mod) return;
  for (const fnName of CONNECT_FNS) {
    const original = mod[fnName];
    if (typeof original !== "function" || original.__evalkit) continue;

    const wrapped = async function (this: any, ...args: any[]) {
      const weaviateClient = await original.apply(this, args);
      try { wrapCollectionsAccessor(client, weaviateClient); } catch { /* never break connect */ }
      return weaviateClient;
    };
    wrapped.__evalkit = true;
    try {
      mod[fnName] = wrapped;
    } catch {
      // Real ESM module namespace objects are read-only — nothing more we can do
      // automatically here. patchWeaviateClientInstance() is the manual fallback.
    }
  }
}

/** Manual fallback for ESM consumers where patchWeaviateModule() can't rebind the
 *  module's exports: call this on a client you already obtained yourself, e.g.
 *  `patchWeaviateClientInstance(client, await weaviate.connectToLocal())`. */
export function patchWeaviateClientInstance(client: EvalKitClient, weaviateClient: any): any {
  try { wrapCollectionsAccessor(client, weaviateClient); } catch { /* never throw into the caller */ }
  return weaviateClient;
}

function wrapCollectionsAccessor(client: EvalKitClient, weaviateClient: any): void {
  const collections = weaviateClient?.collections;
  if (!collections || collections.__evalkit) return;

  for (const accessor of ["get", "use"] as const) {
    const original = collections[accessor];
    if (typeof original !== "function") continue;
    collections[accessor] = function (this: any, ...args: any[]) {
      const collection = original.apply(this, args);
      try { wrapCollectionInstance(client, collection, args[0]); } catch { /* ignore */ }
      return collection;
    };
  }
  collections.__evalkit = true;
}

function wrapCollectionInstance(client: EvalKitClient, collection: any, name: unknown): void {
  if (!collection || collection.__evalkit) return;
  const collectionName = typeof name === "string" ? name : collection?.name;

  const query = collection.query;
  if (query && typeof query.nearVector === "function" && !query.__evalkit) {
    const originalNearVector = query.nearVector.bind(query);
    query.nearVector = async (vector: any, opts: any = {}, ...rest: any[]) => {
      const end = startVectorDb(client, "weaviate", "query");
      let result: any;
      try {
        result = await originalNearVector(vector, opts, ...rest);
      } catch (err) {
        end("ERROR", undefined, err);
        throw err;
      }
      const matches = matchesSummary(result);
      const attrs: Record<string, string | number | boolean> = {
        "db.vector.match_count": matches.length,
      };
      if (collectionName) attrs["db.vector.collection"] = String(collectionName);
      if (typeof opts?.limit === "number") attrs["db.vector.top_k"] = opts.limit;
      const reqBody = safeBody(opts);
      if (reqBody) attrs["gen_ai.request.body"] = reqBody;
      const respBody = safeBody({ objects: matches });
      if (respBody) attrs["gen_ai.response.body"] = respBody;
      end("OK", attrs);
      return result;
    };
    query.__evalkit = true;
  }

  const data = collection.data;
  if (data && !data.__evalkit) {
    if (typeof data.insert === "function") {
      const originalInsert = data.insert.bind(data);
      data.insert = async (...args: any[]) => {
        const end = startVectorDb(client, "weaviate", "insert");
        let result: any;
        try {
          result = await originalInsert(...args);
        } catch (err) {
          end("ERROR", undefined, err);
          throw err;
        }
        const attrs: Record<string, string | number | boolean> = { "db.vector.count": 1 };
        if (collectionName) attrs["db.vector.collection"] = String(collectionName);
        end("OK", attrs);
        return result;
      };
    }
    if (typeof data.insertMany === "function") {
      const originalInsertMany = data.insertMany.bind(data);
      data.insertMany = async (objects: any[], ...rest: any[]) => {
        const end = startVectorDb(client, "weaviate", "insert_many");
        let result: any;
        try {
          result = await originalInsertMany(objects, ...rest);
        } catch (err) {
          end("ERROR", undefined, err);
          throw err;
        }
        const attrs: Record<string, string | number | boolean> = {};
        if (collectionName) attrs["db.vector.collection"] = String(collectionName);
        if (Array.isArray(objects)) attrs["db.vector.count"] = objects.length;
        end(result?.hasErrors ? "ERROR" : "OK", attrs);
        return result;
      };
    }
    data.__evalkit = true;
  }

  collection.__evalkit = true;
}

function matchesSummary(result: any): Array<{ id: any; distance?: any; certainty?: any; score?: any }> {
  const out: Array<{ id: any; distance?: any; certainty?: any; score?: any }> = [];
  try {
    for (const o of result?.objects ?? []) {
      const entry: { id: any; distance?: any; certainty?: any; score?: any } = { id: o?.uuid };
      if (o?.metadata?.distance != null) entry.distance = o.metadata.distance;
      if (o?.metadata?.certainty != null) entry.certainty = o.metadata.certainty;
      if (o?.metadata?.score != null) entry.score = o.metadata.score;
      out.push(entry);
    }
  } catch { /* ignore */ }
  return out;
}
