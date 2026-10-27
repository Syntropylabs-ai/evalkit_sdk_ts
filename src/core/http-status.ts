/**
 * Which answers make an incoming request's span an error. By default every 4xx and 5xx answer does, and an
 * exception the server answers with one is recorded on the span: a request the server refused is shown as a
 * failure. `serverErrorStatusCodes` replaces the 400-599 default with codes (`503`) and inclusive ranges
 * (`"500-599"`): `["500-599"]` follows OpenTelemetry's HTTP conventions, where a 4xx is the caller's mistake
 * (a scanner probing `/.env`, an expired token, a body that fails validation), so its span keeps the status
 * code, stays OK and records no exception. Outgoing calls keep a 4xx as an error whatever the setting: there
 * the call failed for the app.
 */

export type StatusCodeSpec = number | string;

type Range = readonly [number, number];

const DEFAULT_RANGES: readonly Range[] = [[400, 599]];
export const DEFAULT_SERVER_ERROR_STATUS_CODES: readonly StatusCodeSpec[] = ["400-599"];

const RANGE_RE = /^\s*(\d{3})\s*-\s*(\d{3})\s*$/;

let ranges: readonly Range[] = DEFAULT_RANGES;

function isCode(n: number): boolean {
  return Number.isInteger(n) && n >= 100 && n <= 599;
}

function rangeOf(spec: unknown): Range | undefined {
  if (typeof spec === "number") return isCode(spec) ? [spec, spec] : undefined;
  if (typeof spec !== "string") return undefined;
  const range = RANGE_RE.exec(spec);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    return isCode(low) && isCode(high) && low <= high ? [low, high] : undefined;
  }
  const single = spec.trim();
  return /^\d{3}$/.test(single) && isCode(Number(single)) ? [Number(single), Number(single)] : undefined;
}

/** Why `value` cannot be `serverErrorStatusCodes`, or undefined when it can. */
export function serverErrorStatusProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'serverErrorStatusCodes must be an array of status codes (503) or ranges ("500-599")';
  for (const spec of value) {
    if (!rangeOf(spec)) {
      const shown = typeof spec === "string" ? JSON.stringify(spec) : typeof spec === "number" ? String(spec) : typeof spec;
      return `serverErrorStatusCodes entries must be status codes from 100 to 599 or ranges such as "500-599" (got ${shown})`;
    }
  }
  return undefined;
}

/** The codes in force from here on; anything but a valid list leaves the 400-599 default. */
export function configureServerErrorStatus(value: unknown): void {
  if (value === undefined || serverErrorStatusProblem(value)) {
    ranges = DEFAULT_RANGES;
    return;
  }
  ranges = (value as unknown[]).map((spec) => rangeOf(spec)!);
}

/** Back to 400-599. */
export function resetServerErrorStatus(): void {
  ranges = DEFAULT_RANGES;
}

/** Whether a server that answered `code` failed. */
export function isServerErrorStatus(code: unknown): boolean {
  if (typeof code !== "number" || !Number.isFinite(code)) return false;
  for (const [low, high] of ranges) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

/** The status of a server span that answered `code`. */
export function serverSpanStatus(code: unknown): "OK" | "ERROR" {
  return isServerErrorStatus(code) ? "ERROR" : "OK";
}

/**
 * The status code an error carries for the framework to answer with: a NestJS HttpException's getStatus(),
 * a hapi Boom's `output.statusCode`, or the `statusCode` / `status` of an http-errors style error. Undefined
 * when it carries none, which every framework answers with a 500.
 */
export function statusOfError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  try {
    const e = error as {
      getStatus?: () => unknown;
      output?: { statusCode?: unknown };
      statusCode?: unknown;
      status?: unknown;
    };
    const candidates = [
      typeof e.getStatus === "function" ? e.getStatus() : undefined,
      e.output?.statusCode,
      e.statusCode,
      e.status,
    ];
    for (const status of candidates) {
      if (isErrorCode(status)) return status;
    }
  } catch {
    // An error whose status cannot be read is answered as a server error.
  }
  return undefined;
}

function isErrorCode(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * The status of an error a web framework raises to answer a request with it, or undefined for any other
 * error: a NestJS HttpException (getStatus() and getResponse()), a Hono HTTPException (getResponse() and
 * `status`), a hapi Boom, or an http-errors error (Koa's ctx.throw(), Express's createError(); it carries
 * `expose`). Narrower than statusOfError(), which reads any `status`: an error from an outgoing call that got
 * a 404 back carries one too, and that one is the app's failure.
 */
export function httpAnswerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  try {
    const e = error as {
      getStatus?: () => unknown;
      getResponse?: unknown;
      status?: unknown;
      statusCode?: unknown;
      isBoom?: unknown;
      output?: { statusCode?: unknown };
      expose?: unknown;
    };
    if (typeof e.getResponse === "function") {
      const status = typeof e.getStatus === "function" ? e.getStatus() : e.status;
      return isErrorCode(status) ? status : undefined;
    }
    if (e.isBoom === true) return isErrorCode(e.output?.statusCode) ? e.output!.statusCode as number : undefined;
    if (typeof e.expose === "boolean") {
      if (isErrorCode(e.status)) return e.status;
      if (isErrorCode(e.statusCode)) return e.statusCode;
    }
  } catch {
    // An error whose status cannot be read is no answer.
  }
  return undefined;
}
