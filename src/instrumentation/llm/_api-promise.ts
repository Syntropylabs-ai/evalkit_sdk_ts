import { swallow } from "../../core/guard.js";

type Thenable = { then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => unknown };

type ApiPromise = Thenable & {
  _thenUnwrap: (transform: (value: unknown) => unknown) => unknown;
  responsePromise: Thenable;
};

function isThenable(value: unknown): value is Thenable {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as Thenable).then === "function";
}

function isApiPromise(value: unknown): value is ApiPromise {
  if (!isThenable(value)) return false;
  const p = value as Partial<ApiPromise>;
  return typeof p._thenUnwrap === "function" && isThenable(p.responsePromise);
}

/**
 * Calls `invoke` and reports how it ended, while the caller keeps what the provider SDK returned. The OpenAI,
 * Anthropic and Groq SDKs return an APIPromise whose `withResponse()`, `asResponse()` and `_thenUnwrap()`
 * (which their `parse()` and stream helpers chain on) a plain Promise lacks. Its result is observed through
 * `_thenUnwrap`, and a failed request through its promise of the raw response, so reading the body stays the
 * caller's. `onResult` may hand back a replacement value; what it throws is swallowed. The caller gets the
 * provider's error as it was raised, synchronously when the SDK threw synchronously.
 */
export function observeCall(
  invoke: () => unknown,
  onResult: (value: unknown) => unknown,
  onError: (err: unknown) => void,
): unknown {
  const report = (err: unknown): void => {
    try {
      onError(err);
    } catch (hookErr) {
      swallow("recording a failed provider call", hookErr);
    }
  };
  const settle = (value: unknown): unknown => {
    try {
      return onResult(value);
    } catch (hookErr) {
      swallow("recording a provider response", hookErr);
      return value;
    }
  };

  let pending: unknown;
  try {
    pending = invoke();
  } catch (err) {
    report(err);
    throw err;
  }

  if (isApiPromise(pending)) {
    try {
      // A handler that returns, so this observation adds no rejection of its own.
      pending.responsePromise.then(undefined, (err) => {
        report(err);
      });
      return pending._thenUnwrap(settle);
    } catch (hookErr) {
      swallow("observing an APIPromise", hookErr);
      return pending;
    }
  }
  if (isThenable(pending)) {
    return pending.then(settle, (err) => {
      report(err);
      throw err;
    });
  }
  return settle(pending);
}
