// Work that must be done before spans are flushed: spans the SDK holds open on the app's behalf (a root it
// opened for a framework's run) are ended first, so a flush at exit sends them with their children.
// Each LangChain handler adds one, and an app may make a handler per request, so the list is capped: the
// oldest hooks go first, and the roots they would end still end on their own idle timer.
const MAX_HOOKS = 256;

const hooks: Array<() => void> = [];

export function beforeFlush(hook: () => void): void {
  hooks.push(hook);
  if (hooks.length > MAX_HOOKS) hooks.splice(0, hooks.length - MAX_HOOKS);
}

export function runBeforeFlush(): void {
  for (const hook of hooks.slice()) {
    try {
      hook();
    } catch {

    }
  }
}
