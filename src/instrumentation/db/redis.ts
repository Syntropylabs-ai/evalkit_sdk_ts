import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { recordError } from '../../core/exceptions.js';
import type { EvalKitClient } from '../../core/client.js';
import { claimPatch } from '../_patched.js';

export function patchRedis(client: EvalKitClient, redisInstance: any): void {

  const protoHasCmd =
    redisInstance?.prototype &&
    (typeof redisInstance.prototype.sendCommand === 'function' || typeof redisInstance.prototype.call === 'function');
  const proto = protoHasCmd ? redisInstance.prototype : Object.getPrototypeOf(redisInstance);
  if (!proto || proto.__evalkit_redis) return;

  const methodName =
    typeof proto.sendCommand === 'function' ? 'sendCommand' :
    typeof proto.call === 'function' ? 'call' : null;

  if (!methodName) return;
  if (!claimPatch(proto, methodName)) return;

  const orig = proto[methodName];

  proto[methodName] = async function (this: any, command: any, ...rest: any[]) {
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan?.isRecording()) return orig.call(this, command, ...rest);

    const rawCmd = Array.isArray(command)
      ? command[0]
      : (command?.name ?? command?.args?.[0] ?? 'cmd');
    const cmdName = (typeof rawCmd === 'string' ? rawCmd : String(rawCmd)).toUpperCase();

    const span = client.tracer.startSpan(`redis ${cmdName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'db_query',
        'db.system': 'redis',
        'db.operation': cmdName,
      },
    }, otelContext.active());

    try {
      const result = await orig.call(this, command, ...rest);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      recordError(span, error, { escaped: true });
      span.end();
      throw err;
    }
  };

  proto.__evalkit_redis = true;
}
