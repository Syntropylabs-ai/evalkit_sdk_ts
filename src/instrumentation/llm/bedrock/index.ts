import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { safeBody } from "../_body.js";

// Matches @aws-sdk/client-bedrock-runtime ConverseCommand input/output shapes
type ConverseInput = {
  modelId?: string;
  messages?: Array<{ role: string; content: Array<{ text?: string }> }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
};
type ConverseContentBlock = {
  text?: string;
  reasoningContent?: { reasoningText?: { text?: string }; redactedContent?: unknown };
};
type ConverseOutput = {
  output?: { message?: { content?: ConverseContentBlock[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

/**
 * Pulls Converse API reasoningContent blocks out of the output message.
 * Anthropic (and other reasoning-capable) models on Bedrock surface their
 * chain-of-thought this way; redacted variants carry only an opaque encrypted
 * payload, so we just flag their presence.
 */
function extractReasoning(content: ConverseContentBlock[]): { thinkingText: string; hasRedactedThinking: boolean } {
  const thinkingText = content
    .map((c) => c.reasoningContent?.reasoningText?.text ?? "")
    .join("");
  const hasRedactedThinking = content.some((c) => c.reasoningContent?.redactedContent != null);
  return { thinkingText, hasRedactedThinking };
}
type BedrockClient = {
  send: (...args: unknown[]) => Promise<unknown>;
  config?: { region?: string | (() => Promise<string>) };
};

function isConverseCommand(command: unknown): boolean {
  if (!command || typeof command !== 'object') return false;
  const ctor = (command as any).constructor?.name ?? '';
  return ctor === 'ConverseCommand' || ctor === 'ConverseStreamCommand';
}

export function patchBedrock(
  client: EvalKitClient,
  bedrockClient: BedrockClient,
  parentCtx?: OtelContext
): void {
  if ((bedrockClient.send as any).__evalkit) return;

  const original = bedrockClient.send;

  bedrockClient.send = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const command = args[0] as any;

    if (!isConverseCommand(command)) {
      return original.apply(this, args);
    }

    const input = command.input as ConverseInput;
    const modelId = input?.modelId ?? 'unknown';
    const provider = modelId.split('.')[0] ?? 'bedrock';

    const systemText = input?.system?.map((s) => s.text).join('\n') ?? '';
    const promptLines = input?.messages?.map(
      (m) => `${m.role}: ${m.content.map((c) => c.text ?? '').join('')}`
    ) ?? [];
    const promptText = [systemText ? `system: ${systemText}` : '', ...promptLines]
      .filter(Boolean)
      .join('\n');

    const inferCfg = input?.inferenceConfig ?? {};
    const ctx = parentCtx ?? otelContext.active();

    const span = client.tracer.startSpan(
      'converse',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'evalkit.span_type': 'llm_call',
          'gen_ai.system': provider,
          'gen_ai.request.model': modelId,
          ...(inferCfg.temperature != null && { 'gen_ai.request.temperature': inferCfg.temperature }),
          ...(inferCfg.maxTokens != null && { 'gen_ai.request.max_tokens': inferCfg.maxTokens }),
          ...(inferCfg.topP != null && { 'gen_ai.request.top_p': inferCfg.topP }),
          'evalkit.prompt': promptText,
        },
      },
      ctx
    );

    const reqBody = safeBody(input);
    if (reqBody) span.setAttribute('gen_ai.request.body', reqBody);

    const spanCtx = trace.setSpan(ctx, span);

    let result: ConverseOutput;
    try {
      result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as ConverseOutput;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      throw err;
    }

    const outputContent = result.output?.message?.content ?? [];
    const completionText = outputContent.map((c) => c.text ?? '').join('');
    const { thinkingText, hasRedactedThinking } = extractReasoning(outputContent);

    span.setAttributes({
      'gen_ai.response.model': modelId,
      'gen_ai.usage.input_tokens': result.usage?.inputTokens ?? 0,
      'gen_ai.usage.output_tokens': result.usage?.outputTokens ?? 0,
      'gen_ai.usage.total_tokens': result.usage?.totalTokens ?? 0,
      'gen_ai.response.finish_reasons': result.stopReason ? [result.stopReason] : [],
      'evalkit.completion': completionText,
      ...(thinkingText && { 'gen_ai.response.thinking': thinkingText }),
      ...(hasRedactedThinking && { 'gen_ai.response.has_redacted_thinking': true }),
    });

    const respBody = safeBody(result);
    if (respBody) span.setAttribute('gen_ai.response.body', respBody);

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  };

  (bedrockClient.send as any).__evalkit = true;
}
