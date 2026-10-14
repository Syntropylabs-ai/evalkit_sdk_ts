import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { safeBody } from "../_body.js";
import { toolAttrs } from "../_request.js";
import { fromConverseBlocks } from "../_toolcalls.js";
import { BEDROCK_PROVIDER, applyResponse, endSpan, failSpan, toError } from "./_attrs.js";
import {
  createInvokeStreamAccumulator,
  detectFamily,
  parseInvokeRequest,
  parseInvokeResponse,
  parseJsonBlob,
} from "./_families.js";
import type { BedrockFamily, BedrockResponseInfo, BedrockUsage } from "./_families.js";
import {
  CONVERSE_STREAM_EXCEPTIONS,
  RESPONSE_STREAM_EXCEPTIONS,
  findEventStream,
  replaceMember,
  streamException,
  teeAsyncIterable,
} from "./_stream.js";
import { claimPatch } from "../../_patched.js";
import { claimFrameworkModelRun } from '../../../core/framework-model-call.js';

export { patchBedrockAgentRuntime } from "./_agent.js";

type ConverseInput = {
  modelId?: string;
  messages?: Array<{ role?: string; content?: Array<{ text?: string }> }>;
  system?: Array<{ text?: string }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
  toolConfig?: { tools?: unknown[] };
};
type ConverseContentBlock = {
  text?: string;
  reasoningContent?: { reasoningText?: { text?: string }; redactedContent?: unknown };
};
type ConverseUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};
type ConverseOutput = {
  output?: { message?: { content?: ConverseContentBlock[] } };
  stopReason?: string;
  usage?: ConverseUsage;
  trace?: { promptRouter?: { invokedModelId?: string } };
};
type InvokeModelInput = { modelId?: string; body?: unknown };
type BedrockClient = {
  send: (...args: unknown[]) => Promise<unknown>;
  config?: { region?: string | (() => Promise<string>) };
  middlewareStack?: { add?: (middleware: unknown, options?: unknown) => void };
};

const HEADER_INPUT_TOKENS = 'x-amzn-bedrock-input-token-count';
const HEADER_OUTPUT_TOKENS = 'x-amzn-bedrock-output-token-count';
const RESPONSE_HEADERS = Symbol('evalkit.bedrock.response_headers');

type RuntimeOp = 'converse' | 'converse_stream' | 'invoke_model' | 'invoke_model_stream';

const RUNTIME_OPS: Record<string, { op: RuntimeOp; span: string }> = {
  ConverseCommand: { op: 'converse', span: 'converse' },
  ConverseStreamCommand: { op: 'converse_stream', span: 'converse_stream' },
  InvokeModelCommand: { op: 'invoke_model', span: 'invoke_model' },
  InvokeModelWithResponseStreamCommand: {
    op: 'invoke_model_stream',
    span: 'invoke_model_with_response_stream',
  },
};

function captureResponseHeaders(bedrockClient: BedrockClient): void {
  const add = bedrockClient?.middlewareStack?.add;
  if (typeof add !== 'function') return;
  try {
    add.call(
      bedrockClient.middlewareStack,
      (next: (args: unknown) => Promise<{ response?: unknown; output?: unknown }>) =>
        async (args: unknown) => {
          const result = await next(args);
          try {
            const headers = (result?.response as { headers?: unknown } | undefined)?.headers;
            if (result?.output && headers && typeof headers === 'object') {
              Object.defineProperty(result.output, RESPONSE_HEADERS, {
                value: headers,
                enumerable: false,
                configurable: true,
                writable: true,
              });
            }
          } catch {  }
          return result;
        },
      { step: 'deserialize', name: 'evalkitBedrockResponseHeaders', override: true },
    );
  } catch {  }
}

function headerCount(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function headerUsage(result: unknown): BedrockUsage {
  const headers = (result as Record<symbol, unknown> | undefined)?.[RESPONSE_HEADERS];
  if (!headers || typeof headers !== 'object') return {};
  const lowered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    lowered[key.toLowerCase()] = value;
  }
  return {
    inputTokens: headerCount(lowered[HEADER_INPUT_TOKENS]),
    outputTokens: headerCount(lowered[HEADER_OUTPUT_TOKENS]),
  };
}

function withHeaderFallback(info: BedrockResponseInfo, result: unknown): BedrockResponseInfo {
  if (info.inputTokens !== undefined && info.outputTokens !== undefined) return info;
  const fromHeaders = headerUsage(result);
  const inputTokens = info.inputTokens ?? fromHeaders.inputTokens;
  const outputTokens = info.outputTokens ?? fromHeaders.outputTokens;
  const totalTokens =
    info.totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return {
    ...info,
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
  };
}

function runtimeOp(command: unknown): { op: RuntimeOp; span: string } | undefined {
  if (!command || typeof command !== 'object') return undefined;
  const ctor = (command as any).constructor?.name ?? '';
  return RUNTIME_OPS[ctor];
}

function extractReasoning(content: ConverseContentBlock[]): { thinkingText: string; hasRedactedThinking: boolean } {
  const thinkingText = content.map((c) => c?.reasoningContent?.reasoningText?.text ?? '').join('');
  const hasRedactedThinking = content.some((c) => c?.reasoningContent?.redactedContent != null);
  return { thinkingText, hasRedactedThinking };
}

function conversePrompt(input: ConverseInput): string {
  const systemText = (input?.system ?? []).map((s) => s?.text ?? '').join('\n');
  const promptLines = (input?.messages ?? []).map(
    (m) => `${m?.role ?? 'message'}: ${(m?.content ?? []).map((c) => c?.text ?? '').join('')}`,
  );
  return [systemText ? `system: ${systemText}` : '', ...promptLines].filter(Boolean).join('\n');
}

function usageInfo(usage: ConverseUsage | undefined): BedrockResponseInfo {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: usage?.cacheReadInputTokens,
    cacheWriteTokens: usage?.cacheWriteInputTokens,
  };
}

function converseResponseInfo(result: ConverseOutput): BedrockResponseInfo {
  try {
    const raw = result?.output?.message?.content;
    const content: ConverseContentBlock[] = Array.isArray(raw) ? raw : [];
    const { thinkingText, hasRedactedThinking } = extractReasoning(content);
    return {
      ...usageInfo(result?.usage),
      completion: content.map((c) => c?.text ?? '').join(''),
      ...(thinkingText && { thinking: thinkingText }),
      ...(hasRedactedThinking && { hasRedactedThinking: true }),
      finishReason: result?.stopReason,
      responseModel: result?.trace?.promptRouter?.invokedModelId,
      toolCalls: fromConverseBlocks(content),
    };
  } catch {
    return usageInfo(result?.usage);
  }
}

function createConverseStreamAccumulator(startMs: number) {
  let completion = '';
  let thinking = '';
  let hasRedactedThinking = false;
  let finishReason: string | undefined;
  let responseModel: string | undefined;
  let usage: BedrockResponseInfo = {};
  let ttftMs: number | undefined;
  const toolBlocks = new Map<number, { toolUseId: string; name: string; input: string }>();

  const blockIndex = (event: any): number =>
    typeof event?.contentBlockIndex === 'number' ? event.contentBlockIndex : -1;

  return {
    push(event: any): void {
      const start = event?.contentBlockStart;
      const startedTool = start?.start?.toolUse;
      if (startedTool) {
        toolBlocks.set(blockIndex(start), {
          toolUseId: typeof startedTool.toolUseId === 'string' ? startedTool.toolUseId : '',
          name: typeof startedTool.name === 'string' ? startedTool.name : '',
          input: '',
        });
      }

      const blockDelta = event?.contentBlockDelta;
      if (blockDelta) {
        const delta = blockDelta.delta;
        const text = delta?.text;
        if (typeof text === 'string' && text) {
          if (ttftMs === undefined) ttftMs = Date.now() - startMs;
          completion += text;
        }
        const reasoning = delta?.reasoningContent;
        if (typeof reasoning?.text === 'string' && reasoning.text) {
          if (ttftMs === undefined) ttftMs = Date.now() - startMs;
          thinking += reasoning.text;
        }
        if (reasoning?.redactedContent != null) hasRedactedThinking = true;
        const toolInput = delta?.toolUse?.input;
        if (typeof toolInput === 'string' && toolInput) {
          const entry = toolBlocks.get(blockIndex(blockDelta));
          if (entry) entry.input += toolInput;
        }
      }

      const stopReason = event?.messageStop?.stopReason;
      if (typeof stopReason === 'string' && stopReason) finishReason = stopReason;

      const metadata = event?.metadata;
      if (metadata) {
        usage = usageInfo(metadata.usage);
        const invoked = metadata.trace?.promptRouter?.invokedModelId;
        if (typeof invoked === 'string' && invoked) responseModel = invoked;
      }
    },
    snapshot(): { info: BedrockResponseInfo; ttftMs: number | undefined } {
      const toolCalls = fromConverseBlocks(
        [...toolBlocks.values()].map((t) => ({
          toolUse: { toolUseId: t.toolUseId, name: t.name, input: t.input || {} },
        })),
      );
      return {
        info: {
          ...usage,
          completion,
          ...(thinking && { thinking }),
          ...(hasRedactedThinking && { hasRedactedThinking: true }),
          finishReason,
          ...(responseModel && { responseModel }),
          ...(toolCalls.length > 0 && { toolCalls }),
        },
        ttftMs,
      };
    },
  };
}

function startConverseSpan(
  client: EvalKitClient,
  spanName: string,
  input: ConverseInput,
  modelId: string,
  ctx: OtelContext,
): Span {
  const inferCfg = input?.inferenceConfig ?? {};
  const span = client.tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'llm_call',
        'gen_ai.system': BEDROCK_PROVIDER,
        'gen_ai.request.model': modelId,
        ...(inferCfg.temperature != null && { 'gen_ai.request.temperature': inferCfg.temperature }),
        ...(inferCfg.maxTokens != null && { 'gen_ai.request.max_tokens': inferCfg.maxTokens }),
        ...(inferCfg.topP != null && { 'gen_ai.request.top_p': inferCfg.topP }),
        ...toolAttrs(input?.toolConfig?.tools),
        'evalkit.prompt': conversePrompt(input),
      },
    },
    ctx,
  );
  const reqBody = safeBody(input);
  if (reqBody) span.setAttribute('gen_ai.request.body', reqBody);
  return span;
}

function startInvokeModelSpan(
  client: EvalKitClient,
  spanName: string,
  input: InvokeModelInput,
  modelId: string,
  family: BedrockFamily,
  ctx: OtelContext,
): Span {
  const requestBody = parseJsonBlob(input?.body);
  const info = parseInvokeRequest(family, requestBody);
  const span = client.tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'llm_call',
        'gen_ai.system': BEDROCK_PROVIDER,
        'gen_ai.request.model': modelId,
        ...(info.temperature != null && { 'gen_ai.request.temperature': info.temperature }),
        ...(info.maxTokens != null && { 'gen_ai.request.max_tokens': info.maxTokens }),
        ...(info.topP != null && { 'gen_ai.request.top_p': info.topP }),
        // Anthropic, Mistral and Cohere bodies list tools at the top, Nova under toolConfig like Converse.
        ...toolAttrs(requestBody?.tools, requestBody?.toolConfig?.tools),
        'evalkit.prompt': info.prompt,
      },
    },
    ctx,
  );
  const reqBody = safeBody(requestBody);
  if (reqBody) span.setAttribute('gen_ai.request.body', reqBody);
  return span;
}

function traceConverseStream(
  client: EvalKitClient,
  span: Span,
  result: any,
  modelId: string,
  startMs: number,
): unknown {
  const found = findEventStream(result, 'stream');
  if (!found) {
    applyResponse(client, span, {}, modelId, { streaming: true });
    endSpan(span);
    return result;
  }

  const accumulator = createConverseStreamAccumulator(startMs);
  let streamError: Error | undefined;
  let finished = false;

  const onEvent = (event: any) => {
    const err = streamException(event, CONVERSE_STREAM_EXCEPTIONS);
    if (err) streamError = err;
    accumulator.push(event);
  };

  const onDone = (error?: Error) => {
    if (finished) return;
    finished = true;
    const failure = error ?? streamError;
    const { info, ttftMs } = accumulator.snapshot();
    applyResponse(client, span, info, modelId, { streaming: true, ttftMs, error: failure });
    endSpan(span);
  };

  return replaceMember(result, found.key, teeAsyncIterable(found.stream, onEvent, onDone));
}

function traceInvokeModelStream(
  client: EvalKitClient,
  span: Span,
  result: any,
  modelId: string,
  family: BedrockFamily,
  startMs: number,
): unknown {
  const found = findEventStream(result, 'body');
  if (!found) {
    applyResponse(client, span, {}, modelId, { streaming: true });
    endSpan(span);
    return result;
  }

  const accumulator = createInvokeStreamAccumulator(family);
  let streamError: Error | undefined;
  let finished = false;

  const onEvent = (event: any) => {
    const err = streamException(event, RESPONSE_STREAM_EXCEPTIONS);
    if (err) streamError = err;
    const chunk = parseJsonBlob(event?.chunk?.bytes);
    if (chunk !== undefined) accumulator.push(chunk);
  };

  const onDone = (error?: Error) => {
    if (finished) return;
    finished = true;
    const failure = error ?? streamError;
    const snapshot = accumulator.snapshot();
    const ttftMs = snapshot.firstTextMs === undefined ? undefined : snapshot.firstTextMs - startMs;
    applyResponse(client, span, snapshot, modelId, { streaming: true, ttftMs, error: failure });
    endSpan(span);
  };

  return replaceMember(result, found.key, teeAsyncIterable(found.stream, onEvent, onDone));
}

export function patchBedrock(
  client: EvalKitClient,
  bedrockClient: BedrockClient,
  parentCtx?: OtelContext,
): void {
  if (typeof bedrockClient?.send !== 'function') return;
  if ((bedrockClient.send as any).__evalkit) return;
  if (!claimPatch(bedrockClient, "send")) return;

  captureResponseHeaders(bedrockClient);

  const original = bedrockClient.send;

  bedrockClient.send = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const command = args[0] as any;
    const entry = runtimeOp(command);
    if (!entry) return original.apply(this, args);

    let span: Span;
    let spanCtx: OtelContext;
    let modelId: string;
    let family: BedrockFamily;
    const startMs = Date.now();
    try {
      const input = command.input ?? {};
      modelId = typeof input.modelId === 'string' && input.modelId ? input.modelId : 'unknown';
      family = detectFamily(modelId);
      const framework = claimFrameworkModelRun();
      const ctx = parentCtx ?? framework?.ctx ?? otelContext.active();
      span =
        entry.op === 'converse' || entry.op === 'converse_stream'
          ? startConverseSpan(client, entry.span, input as ConverseInput, modelId, ctx)
          : startInvokeModelSpan(client, entry.span, input as InvokeModelInput, modelId, family, ctx);
      if (framework) span.setAttributes(framework.attributes);
      spanCtx = trace.setSpan(ctx, span);
    } catch {
      return original.apply(this, args);
    }

    let result: any;
    try {
      result = await otelContext.with(spanCtx, () => original.apply(this, args));
    } catch (err) {
      failSpan(span, toError(err));
      throw err;
    }

    if (entry.op === 'converse_stream') {
      return traceConverseStream(client, span, result, modelId, startMs);
    }
    if (entry.op === 'invoke_model_stream') {
      return traceInvokeModelStream(client, span, result, modelId, family, startMs);
    }
    if (entry.op === 'converse') {
      applyResponse(client, span, converseResponseInfo(result as ConverseOutput), modelId, {
        responseBody: result,
      });
      endSpan(span);
      return result;
    }

    const responseBody = parseJsonBlob(result?.body);
    const info = withHeaderFallback(parseInvokeResponse(family, responseBody), result);
    applyResponse(client, span, info, modelId, {
      responseBody: responseBody ?? undefined,
    });
    endSpan(span);
    return result;
  };

  (bedrockClient.send as any).__evalkit = true;
}
