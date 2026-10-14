// Work that must be done before spans are flushed: spans the SDK holds open on the app's behalf (a root it
// opened for a framework's run) are ended first, so a flush at exit sends them with their children.
const hooks: Array<() => void> = [];

export function beforeFlush(hook: () => void): void {
  hooks.push(hook);
}

export function runBeforeFlush(): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch {

    }
  }
}
