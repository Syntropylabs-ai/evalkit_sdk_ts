import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';

export function patchPg(client: EvalKitClient, pgInstance: any): void {
  const proto = pgInstance?.prototype ?? Object.getPrototypeOf(pgInstance);
  if (!proto || proto.__evalkit_pg) return;

  const origQuery = proto.query;
  if (typeof origQuery !== 'function') return;

  proto.query = function (this: any, ...args: any[]): any {
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return origQuery.apply(this, args);

    const queryText: string =
      typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? args[0]?.name ?? 'query');
    const values: unknown[] | undefined =
      Array.isArray(args[1]) ? args[1] : (args[0]?.values ?? undefined);

    const opMatch = queryText.trim().match(/^(\w+)/);
    const op = opMatch?.[1]?.toUpperCase() ?? 'QUERY';
    const tableMatch = queryText.match(/(?:FROM|INTO|UPDATE|JOIN)\s+"?(\w+)"?/i);
    const table = tableMatch?.[1] ?? '';
    const spanName = table ? `${op} ${table}` : `pg ${op}`;

    const span = client.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'db_query',
        'db.system': 'postgresql',
        'db.operation': op,
        'db.statement': queryText.slice(0, 2048),
        ...(values !== undefined ? { 'db.params': JSON.stringify(values).slice(0, 1024) } : {}),
        ...(table ? { 'db.sql.table': table } : {}),
      },
    }, otelContext.active());

    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'function') {
      const cb = lastArg;
      const newArgs = args.slice(0, -1).concat([
        (err: Error | null, result: any) => {
          if (err) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.setAttribute('error.message', err.message);
          } else {
            span.setAttribute('db.rows_affected', result?.rowCount ?? 0);
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
          cb(err, result);
        },
      ]);
      return origQuery.apply(this, newArgs);
    }

    const promise: Promise<any> = origQuery.apply(this, args);
    return promise.then(
      (result: any) => {
        span.setAttribute('db.rows_affected', result?.rowCount ?? 0);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      },
      (err: any) => {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.setAttribute('error.message', error.message);
        span.end();
        throw err;
      },
    );
  };

  proto.__evalkit_pg = true;
}
