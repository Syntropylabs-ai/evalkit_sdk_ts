import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';
import { claimPatch } from '../_patched.js';

export function patchMongoose(client: EvalKitClient, mongoose: any): void {
  const QueryProto = mongoose.Query?.prototype;
  if (!QueryProto || QueryProto.__evalkit) return;
  if (!claimPatch(QueryProto, 'exec')) return;

  const origExec = QueryProto.exec;

  QueryProto.exec = async function (this: any) {
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return origExec.call(this);

    const op = this.op ?? 'query';
    const collection =
      this.model?.collection?.name ??
      this._collection?.collectionName ??
      'unknown';

    const span = client.tracer.startSpan(`${op} ${collection}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'db_query',
        'db.system': 'mongodb',
        'db.operation': op,
        'db.collection': collection,
        'db.query': JSON.stringify(this._conditions ?? {}),
      },
    }, otelContext.active());

    try {
      const result = await origExec.call(this);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }
  };

  QueryProto.__evalkit = true;
}
