import type { EvalKitClient } from '../../core/client.js';

export function instrumentPrisma(client: EvalKitClient, prisma: any, opts: { system?: string } = {}): any {
  if (!prisma || typeof prisma.$extends !== 'function') return prisma;
  return prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query }: any) {

        let end: ((status?: 'OK' | 'ERROR', extra?: Record<string, string | number | boolean>) => void) | undefined;
        try {
          end = client.startSpan(`${model ?? 'raw'}.${operation}`, {
            'evalkit.span_type': 'db_query',
            'db.operation': String(operation),
            ...(opts.system ? { 'db.system': opts.system } : {}),
            ...(model ? { 'db.model': String(model), 'db.sql.table': String(model) } : {}),
          }).end;
        } catch {
          return query(args);
        }
        try {
          const result = await query(args);
          try { end('OK'); } catch {  }
          return result;
        } catch (e: any) {
          try { end('ERROR', { 'error.message': String(e?.message ?? e) }); } catch {  }
          throw e;
        }
      },
    },
  });
}
