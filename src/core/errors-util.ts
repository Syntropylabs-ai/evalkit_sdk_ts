const STACK_MAX = 8192;

export function firstStackFrame(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n').slice(1);
  const grab = (l: string) => l.match(/\(?([^\s()]+:\d+:\d+)\)?\s*$/)?.[1];
  for (const l of lines) {
    const f = grab(l);
    if (f && !f.includes('node:internal') && !f.includes('/node_modules/') && !f.includes('\\node_modules\\')) return f;
  }
  for (const l of lines) { const f = grab(l); if (f) return f; }
  return undefined;
}

export function errorAttrs(err: unknown): Record<string, string> {
  const e = err instanceof Error ? err : new Error(String(err));
  const a: Record<string, string> = {
    'error.message': e.message,
    'error.type': e.name || 'Error',
  };
  try {
    const src = firstStackFrame(e.stack);
    if (src) a['error.source'] = src;
    if (e.stack) a['error.stack'] = e.stack.length > STACK_MAX ? e.stack.slice(0, STACK_MAX) + '…' : e.stack;
  } catch {  }
  return a;
}
