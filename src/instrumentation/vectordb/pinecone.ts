import type { EvalKitClient } from "../../core/client.js";
import { safeBody, startVectorDb } from "./_common.js";
import { claimPatch } from "../_patched.js";

function matchesSummary(response: any): Array<{ id: any; score: any }> {
  const out: Array<{ id: any; score: any }> = [];
  try {
    for (const m of response?.matches ?? []) {
      out.push({ id: m?.id, score: m?.score });
    }
  } catch {  }
  return out;
}

export function patchPineconeIndex(client: EvalKitClient, IndexClass: any): void {
  if (!IndexClass?.prototype) return;
  patchQuery(client, IndexClass.prototype);
  patchUpsert(client, IndexClass.prototype);
}

function patchQuery(client: EvalKitClient, proto: any): void {
  if (typeof proto.query !== "function" || proto.query.__evalkit || !claimPatch(proto, "query")) return;
  const original = proto.query;

  proto.query = async function (this: any, options: any, ...rest: any[]) {
    const end = startVectorDb(client, "pinecone", "query");
    let result: any;
    try {
      result = await original.call(this, options, ...rest);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const matches = matchesSummary(result);
    const attrs: Record<string, string | number | boolean> = {
      "db.vector.match_count": matches.length,
    };
    if (options?.namespace) attrs["db.vector.namespace"] = options.namespace;
    if (typeof options?.topK === "number") attrs["db.vector.top_k"] = options.topK;
    const reqBody = safeBody({ ...options, vector: undefined, sparseVector: undefined });
    if (reqBody) attrs["gen_ai.request.body"] = reqBody;
    const respBody = safeBody({ matches, namespace: result?.namespace });
    if (respBody) attrs["gen_ai.response.body"] = respBody;
    end("OK", attrs);
    return result;
  };
  proto.query.__evalkit = true;
}

function patchUpsert(client: EvalKitClient, proto: any): void {
  if (typeof proto.upsert !== "function" || proto.upsert.__evalkit || !claimPatch(proto, "upsert")) return;
  const original = proto.upsert;

  proto.upsert = async function (this: any, options: any, ...rest: any[]) {
    const records = Array.isArray(options) ? options : options?.records;
    const namespace = Array.isArray(options) ? undefined : options?.namespace;
    const end = startVectorDb(client, "pinecone", "upsert");
    let result: any;
    try {
      result = await original.call(this, options, ...rest);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const attrs: Record<string, string | number | boolean> = {};
    if (namespace) attrs["db.vector.namespace"] = namespace;
    if (Array.isArray(records)) attrs["db.vector.count"] = records.length;
    end("OK", attrs);
    return result;
  };
  proto.upsert.__evalkit = true;
}
