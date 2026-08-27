export const CONVERSE_STREAM_EXCEPTIONS = [
  'internalServerException',
  'modelStreamErrorException',
  'serviceUnavailableException',
  'throttlingException',
  'validationException',
] as const;

export const RESPONSE_STREAM_EXCEPTIONS = [
  'internalServerException',
  'modelStreamErrorException',
  'modelTimeoutException',
  'serviceUnavailableException',
  'throttlingException',
  'validationException',
] as const;

export const AGENT_STREAM_EXCEPTIONS = [
  'accessDeniedException',
  'badGatewayException',
  'conflictException',
  'dependencyFailedException',
  'internalServerException',
  'modelNotReadyException',
  'resourceNotFoundException',
  'serviceQuotaExceededException',
  'throttlingException',
  'validationException',
] as const;

export function streamException(event: any, members: readonly string[]): Error | undefined {
  try {
    for (const member of members) {
      const payload = event?.[member];
      if (payload == null) continue;
      const message = typeof payload?.message === 'string' && payload.message ? payload.message : member;
      return new Error(`${member}: ${message}`);
    }
  } catch {  }
  return undefined;
}

export function isAsyncIterable(value: unknown): boolean {
  return !!value && typeof (value as any)[Symbol.asyncIterator] === 'function';
}

export function findEventStream(result: any, preferred: string): { key: string; stream: any } | undefined {
  try {
    if (isAsyncIterable(result?.[preferred])) return { key: preferred, stream: result[preferred] };
    for (const key of Object.keys(result ?? {})) {
      if (key === '$metadata') continue;
      if (isAsyncIterable(result[key])) return { key, stream: result[key] };
    }
  } catch {  }
  return undefined;
}

export function teeAsyncIterable(
  source: any,
  onEvent: (event: any) => void,
  onDone: (error?: Error) => void,
): any {
  const safeEvent = (event: any) => { try { onEvent(event); } catch {  } };
  const safeDone = (error?: Error) => { try { onDone(error); } catch {  } };

  return new Proxy(source, {
    get(target: any, prop: string | symbol, receiver: any) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const iter = target[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const result = await iter.next();
                if (!result.done && result.value) safeEvent(result.value);
                if (result.done) safeDone();
                return result;
              } catch (err: any) {
                safeDone(err instanceof Error ? err : new Error(String(err)));
                throw err;
              }
            },
            return() {
              safeDone();
              return iter.return?.() ?? Promise.resolve({ done: true, value: undefined });
            },
            throw(err?: any) {
              safeDone(err instanceof Error ? err : new Error(String(err)));
              return iter.throw?.(err) ?? Promise.reject(err);
            },
            [Symbol.asyncIterator]() { return this; },
          };
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

export function replaceMember(target: any, key: string, replacement: unknown): any {
  try {
    return new Proxy(target, {
      get(t: any, prop: string | symbol, receiver: any) {
        if (prop === key) return replacement;
        const val = Reflect.get(t, prop, receiver);
        return typeof val === 'function' ? val.bind(t) : val;
      },
    });
  } catch {
    return target;
  }
}
