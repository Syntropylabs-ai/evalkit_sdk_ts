import { requireBuiltin } from "../utils/dynimport.js";
import { swallow } from "./guard.js";

// Spans wait in memory until their batch is exported, so a process that exits between exports loses the
// last of them: a script that ends, a container stopped with SIGTERM, a developer's Ctrl-C.

export interface ExitHookTarget {
  /** Whether the client in force wants exit hooks (its `exitHooks` option); read when the process exits. */
  wanted(): boolean;
  /** Whether spans are waiting for export. */
  pending(): boolean;
  flush(timeoutMs: number): Promise<boolean>;
}

const BEFORE_EXIT_FLUSH_MS = 5000;
const SIGNAL_FLUSH_MS = 3000;
// beforeExit fires again once the flush's own I/O is done; this caps how often it flushes then.
const MAX_BEFORE_EXIT_FLUSHES = 3;

const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGTERM: 15 };

let installed = false;

function isMainThread(): boolean {
  try {
    return requireBuiltin<{ isMainThread?: boolean }>("node:worker_threads").isMainThread !== false;
  } catch {
    return true;
  }
}

/**
 * Flushes spans as the process exits, once per process: on `beforeExit` (the event loop ran dry), and on
 * SIGTERM / SIGINT when the app has no listener of its own for the signal. A flush on its way out that runs
 * out of time abandons the export, so a receiver that does not answer never holds the exit up. A signal is then answered within
 * 3 s by its default action, as without the SDK: the SDK's listener leaves and the signal is raised again.
 * An app with its own listener handles the signal itself and the SDK stays out of its way.
 */
export function installExitHooks(target: ExitHookTarget): void {
  if (installed) return;
  if (typeof process === "undefined" || typeof process.on !== "function" || typeof process.kill !== "function") return;
  if (!isMainThread()) return;
  installed = true;

  let beforeExitFlushes = 0;
  try {
    process.on("beforeExit", () => {
      try {
        if (!target.wanted()) return;
        // The first time also ends spans the SDK holds open for the app; after it, only queued spans call
        // for another round.
        if (beforeExitFlushes > 0 && !target.pending()) return;
        if (beforeExitFlushes >= MAX_BEFORE_EXIT_FLUSHES) return;
        beforeExitFlushes++;
        void target.flush(BEFORE_EXIT_FLUSH_MS);
      } catch (err) {
        swallow("flushing before exit", err);
      }
    });
  } catch (err) {
    swallow("installing the beforeExit hook", err);
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const onSignal = (): void => {
      let others = 0;
      try {
        others = process.listeners(signal).filter((l) => l !== onSignal).length;
      } catch {
        others = 0;
      }
      try {
        process.removeListener(signal, onSignal);
      } catch {
        // Raising the signal again below still ends the process.
      }
      // The app answers this signal itself, and the SDK steps aside for good: whatever the app decided
      // happens untouched, and a library that raises the signal again once its own listener is the last
      // (as signal-exit does) finds it is.
      if (others > 0) return;
      const reraise = (): void => {
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(128 + (SIGNAL_NUMBERS[signal] ?? 1));
        }
      };
      if (!target.wanted()) {
        reraise();
        return;
      }
      let flushing: Promise<unknown>;
      try {
        flushing = target.flush(SIGNAL_FLUSH_MS);
      } catch {
        flushing = Promise.resolve();
      }
      // The flush is bounded on its own; this guards the default action against anything that is not.
      const guard = setTimeout(reraise, SIGNAL_FLUSH_MS + 500);
      flushing.then(
        () => {
          clearTimeout(guard);
          reraise();
        },
        () => {
          clearTimeout(guard);
          reraise();
        },
      );
    };
    try {
      // First in line, so it sees the app's listeners before a `once` listener has removed itself.
      process.prependListener(signal, onSignal);
    } catch (err) {
      swallow(`installing the ${signal} hook`, err);
    }
  }
}
