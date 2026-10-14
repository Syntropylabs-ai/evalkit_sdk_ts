import type { EvalKitClient } from "../../core/client.js";
import { safeBody, startVectorDb } from "./_common.js";
import { claimPatch } from "../_patched.js";

function pointsSummary(response: any): Array<{ id: any; score: any }> {
  const out: Array<{ id: any; score: any }> = [];
  try {
    const points = response?.points ?? response ?? [];
    for (const p of points) out.push({ id: p?.id, score: p?.score });
  } catch {  }
  return out;
}

export function patchQdrantClient(client: EvalKitClient, QdrantClient: any): void {
  if (!QdrantClient?.prototype) return;
  patchQuery(client, QdrantClient.prototype);
  patchUpsert(client, QdrantClient.prototype);
}

function patchQuery(client: EvalKitClient, proto: any): void {
  if (typeof proto.query !== "function" || proto.query.__evalkit || !claimPatch(proto, "query")) return;
  const original = proto.query;

  proto.query = async function (this: any, collectionName: string, args: any = {}, ...rest: any[]) {
    const end = startVectorDb(client, "qdrant", "query");
    let result: any;
    try {
      result = await original.call(this, collectionName, args, ...rest);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const points = pointsSummary(result);
    const attrs: Record<string, string | number | boolean> = {
      "db.vector.collection": collectionName,
      "db.vector.match_count": points.length,
    };
    if (typeof args?.limit === "number") attrs["db.vector.top_k"] = args.limit;
    const reqBody = safeBody({ ...args, query: undefined });
    if (reqBody) attrs["gen_ai.request.body"] = reqBody;
    const respBody = safeBody({ points });
    if (respBody) attrs["gen_ai.response.body"] = respBody;
    end("OK", attrs);
    return result;
  };
  proto.query.__evalkit = true;
}

function patchUpsert(client: EvalKitClient, proto: any): void {
  if (typeof proto.upsert !== "function" || proto.upsert.__evalkit || !claimPatch(proto, "upsert")) return;
  const original = proto.upsert;

  proto.upsert = async function (this: any, collectionName: string, args: any = {}, ...rest: any[]) {
    const end = startVectorDb(client, "qdrant", "upsert");
    let result: any;
    try {
      result = await original.call(this, collectionName, args, ...rest);
    } catch (err) {
      end("ERROR", undefined, err);
      throw err;
    }

    const points = args?.points ?? args?.batch?.ids;
    const attrs: Record<string, string | number | boolean> = {
      "db.vector.collection": collectionName,
    };
    if (Array.isArray(points)) attrs["db.vector.count"] = points.length;
    if (result?.status) attrs["db.vector.status"] = String(result.status);
    end("OK", attrs);
    return result;
  };
  proto.upsert.__evalkit = true;
}
