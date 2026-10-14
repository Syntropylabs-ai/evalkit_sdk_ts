import type { Context as OtelContext } from "@opentelemetry/api";

/**
 * A model run an agent framework reported through its callbacks (a LangChain chat model inside a LangGraph
 * node) that a provider call is about to make. The call is recorded once, by the provider's span: it takes
 * the framework run's place in the tree (`ctx`, its parent) and its attributes (the node it ran in), and the
 * framework's own record of the run is dropped.
 */
export interface FrameworkModelRun {
  ctx: OtelContext;
  attributes: Record<string, string | number>;
}

type Claimer = () => FrameworkModelRun | undefined;

let claimer: Claimer | undefined;

export function setFrameworkModelRunClaimer(fn: Claimer): void {
  claimer = fn;
}

/** The framework model run this provider call belongs to, claimed so no other call takes it. */
export function claimFrameworkModelRun(): FrameworkModelRun | undefined {
  try {
    return claimer?.();
  } catch {
    return undefined;
  }
}
