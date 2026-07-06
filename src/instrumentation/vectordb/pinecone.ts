import type { EvalKitClient } from "../../core/client.js";
import { safeBody, startVectorDb } from "./_common.js";

// Patch @pinecone-database/pinecone's Index.query/upsert at the class level.
//
// RAG pipelines retrieve context from a vector DB before generating a response —
// without this, that lookup is invisible (only the downstream LLM call gets
// traced), making it impossible to tell whether a bad answer came from retrieval
// (wrong/no matches) or generation (bad prompt, bad model). Never captures raw
// embedding vectors — they're large and not useful for a trace.
//
// Degrades to a no-op if @pinecone-database/pinecone isn't installed and never
// throws into the caller.

function matchesSummary(response: any): Array<{ id: any; score: any }> {
  const out: Array<{ id: any; score: any }> = [];
  try {
    for (const m of response?.matches ?? []) {
      out.push({ id: m?.id, score: m?.score });
    }
  } catch { /* ignore */ }
  return out;
}

export function patchPineconeIndex(client: EvalKitClient, IndexClass: any): void {
  if (!IndexClass?.prototype) return;
  patchQuery(client, IndexClass.prototype);
  patchUpsert(client, IndexClass.prototype);
}

function patchQuery(client: EvalKitClient, proto: any): void {
  if (typeof proto.query !== "function" || proto.query.__evalkit) return;
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
  if (typeof proto.upsert !== "function" || proto.upsert.__evalkit) return;
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
