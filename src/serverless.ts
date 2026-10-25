// A serverless function's execution environment is frozen as soon as the invocation returns, and timers
// do not run while it is frozen: spans queued for the next scheduled export wait until the next invocation,
// and are lost when the environment is recycled first. Each invocation therefore flushes before it returns.

export type LambdaHandler = (event: any, context: any, callback?: (...args: any[]) => void) => any;

export interface WithLambdaOptions {
  /** The most each invocation waits for its spans to be sent. Default 2000, never past the invocation's remaining time. */
  flushTimeoutMs?: number;
}

type Flush = (timeoutMs: number) => Promise<boolean>;

const DEFAULT_LAMBDA_FLUSH_MS = 2000;
// Left to the invocation after the flush, so the flush never makes it time out.
const REMAINING_TIME_RESERVE_MS = 250;

function flushBudget(context: unknown, budget: number): number {
  try {
    const remaining = (context as { getRemainingTimeInMillis?: () => number } | undefined)?.getRemainingTimeInMillis?.();
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      return Math.max(0, Math.min(budget, remaining - REMAINING_TIME_RESERVE_MS));
    }
  } catch {
    // Without the remaining time the budget alone applies.
  }
  return budget;
}

export function createWithLambda(flush: Flush) {
  return function withLambda<H extends LambdaHandler>(handler: H, options: WithLambdaOptions = {}): H {
    if (typeof handler !== "function") return handler;
    const budget =
      typeof options.flushTimeoutMs === "number" && options.flushTimeoutMs >= 0 ? options.flushTimeoutMs : DEFAULT_LAMBDA_FLUSH_MS;
    const callbackStyle = handler.length >= 3;

    const wrapped = function (this: unknown, event: unknown, context: unknown, callback?: (...args: any[]) => void): unknown {
      const settle = (): Promise<unknown> => flush(flushBudget(context, budget)).catch(() => false);

      if (callbackStyle && typeof callback === "function") {
        const done = (...args: any[]): void => {
          void settle().then(() => callback(...args));
        };
        let result: unknown;
        try {
          result = handler.call(this, event, context, done);
        } catch (err) {
          return settle().then(() => {
            throw err;
          });
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (value) => settle().then(() => value),
            (err) => settle().then(() => {
              throw err;
            }),
          );
        }
        return result;
      }

      let result: unknown;
      try {
        result = handler.call(this, event, context, callback);
      } catch (err) {
        return settle().then(() => {
          throw err;
        });
      }
      return Promise.resolve(result).then(
        (value) => settle().then(() => value),
        (err) => settle().then(() => {
          throw err;
        }),
      );
    };
    // A runtime that tells handler styles apart by their parameter count sees the handler's own.
    try {
      Object.defineProperty(wrapped, "length", { value: handler.length, configurable: true });
    } catch {
      // The count stays the wrapper's.
    }
    return wrapped as unknown as H;
  };
}

export function createFlushAfter(flush: Flush) {
  return function flushAfter(schedule?: (task: Promise<unknown>) => void, timeoutMs: number = 5000): Promise<boolean> {
    const task = flush(timeoutMs).catch(() => false);
    if (typeof schedule === "function") {
      try {
        schedule(task);
      } catch {
        // Next.js' after() throws outside a request; the flush then simply runs in the background.
      }
    }
    return task;
  };
}
