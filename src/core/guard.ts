// The SDK's instrumentation runs inside the app's own calls, so nothing it does may fail them: each hook
// catches its own errors, the call goes on as if the SDK were not there, and the error is reported only
// with `debug: true`.

// Taken before the console is patched, so reporting an error inside the SDK never records a log span.
const warn = console.warn.bind(console);

let debugEnabled = false;

const reported = new Set<string>();

export function setGuardDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Records an error raised inside the SDK's own code, which the app never sees. Reported once per place. */
export function swallow(where: string, err: unknown): void {
  if (!debugEnabled || reported.has(where)) return;
  reported.add(where);
  try {
    warn(`[evalkit] ${where} failed; the app was not affected:`, err);
  } catch {

  }
}

/** Runs one of the SDK's hooks, returning `fallback` when it throws. */
export function guarded<T>(where: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    swallow(where, err);
    return fallback;
  }
}

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
