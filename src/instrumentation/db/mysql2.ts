import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { EvalKitClient } from '../../core/client.js';

export function patchMysql2(client: EvalKitClient, mysqlInstance: any): void {
  const proto = mysqlInstance?.prototype ?? Object.getPrototypeOf(mysqlInstance);
  if (!proto || proto.__evalkit_mysql2) return;

  for (const method of ['query', 'execute'] as const) {
    const orig = proto[method];
    if (typeof orig !== 'function') continue;

    proto[method] = function (this: any, ...args: any[]): any {
      const activeSpan = trace.getActiveSpan();
      if (!activeSpan?.isRecording()) return orig.apply(this, args);

      const queryText: string =
        typeof args[0] === 'string' ? args[0] : (args[0]?.sql ?? 'query');
      const values: unknown[] | undefined = Array.isArray(args[1]) ? args[1] : undefined;

      const opMatch = queryText.trim().match(/^(\w+)/);
      const op = opMatch?.[1]?.toUpperCase() ?? 'QUERY';
      const tableMatch = queryText.match(/(?:FROM|INTO|UPDATE|JOIN)\s+`?(\w+)`?/i);
      const table = tableMatch?.[1] ?? '';
      const spanName = table ? `${op} ${table}` : `mysql ${op}`;

      const span = client.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: {
          'evalkit.span_type': 'db_query',
          'db.system': 'mysql',
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
          (err: Error | null, rows: any, fields: any) => {
            if (err) {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
              span.setAttribute('error.message', err.message);
            } else {
              span.setAttribute('db.rows_affected', Array.isArray(rows) ? rows.length : (rows?.affectedRows ?? 0));
              span.setStatus({ code: SpanStatusCode.OK });
            }
            span.end();
            cb(err, rows, fields);
          },
        ]);
        return orig.apply(this, newArgs);
      }

      const result = orig.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then(
          ([rows, fields]: [any, any]) => {
            span.setAttribute('db.rows_affected', Array.isArray(rows) ? rows.length : (rows?.affectedRows ?? 0));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return [rows, fields];
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
      }
      span.end();
      return result;
    };
  }

  proto.__evalkit_mysql2 = true;
}
