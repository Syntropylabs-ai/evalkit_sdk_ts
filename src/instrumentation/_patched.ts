// Which members of which objects the SDK has patched. The record is kept beside the objects instead of as a
// flag on the patched function: another library that wraps a patched function (OpenTelemetry's own
// instrumentations do) hides any flag set on it, and patching that wrapper again would record every call
// twice. It lives on globalThis, so the SDK's CommonJS and ESM builds loaded side by side share it.
const REGISTRY_KEY = Symbol.for("evalkit.patched");

type Registry = WeakMap<object, Set<string>>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let found = holder[REGISTRY_KEY];
  if (!found) {
    found = new WeakMap();
    holder[REGISTRY_KEY] = found;
  }
  return found;
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/** Whether `member` of `target`, or of an object `target` inherits from, was already patched. */
export function isPatched(target: unknown, member: string): boolean {
  if (!isObjectLike(target)) return false;
  const reg = registry();
  try {
    for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
      if (reg.get(o)?.has(member)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Claims `member` of `target` for patching: true the first time, false once it, or the same member of an
 * object `target` inherits from, was claimed. Call it after every check that could still decline the patch.
 */
export function claimPatch(target: unknown, member: string): boolean {
  if (!isObjectLike(target) || isPatched(target, member)) return false;
  const reg = registry();
  let members = reg.get(target);
  if (!members) {
    members = new Set();
    reg.set(target, members);
  }
  members.add(member);
  return true;
}
