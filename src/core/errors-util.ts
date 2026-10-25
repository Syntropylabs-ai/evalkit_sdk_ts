import { describeError } from './exceptions.js';

export { firstStackFrame } from './exceptions.js';

/** The `error.*` attributes of an error: its type, message, first own frame and stack (8192 characters at most). */
export function errorAttrs(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const { attributes } = describeError(err);
    for (const key of ['error.message', 'error.type', 'error.source', 'error.stack']) {
      const value = attributes[key];
      if (typeof value === 'string') out[key] = value;
    }
  } catch {
    out['error.type'] = 'Error';
  }
  return out;
}
