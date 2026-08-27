import { SpanKind, context as otelContext, trace } from "@opentelemetry/api";
import type { Span, Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "../../../core/client.js";
import { safeBody } from "../_body.js";
import { startVectorDb } from "../../vectordb/_common.js";
import { BEDROCK_PROVIDER, applyResponse, endSpan, failSpan, toError } from "./_attrs.js";
import { decodeBlob } from "./_families.js";
import {
  AGENT_STREAM_EXCEPTIONS,
  findEventStream,
  replaceMember,
  streamException,
  teeAsyncIterable,
} from "./_stream.js";

type AgentClient = {
  send: (...args: unknown[]) => Promise<unknown>;
};

type AgentOp =
  | 'invoke_agent'
  | 'invoke_inline_agent'
  | 'retrieve'
  | 'retrieve_and_generate'
  | 'retrieve_and_generate_stream';

const AGENT_OPS: Record<string, AgentOp> = {
  InvokeAgentCommand: 'invoke_agent',
  InvokeInlineAgentCommand: 'invoke_inline_agent',
  RetrieveCommand: 'retrieve',
  RetrieveAndGenerateCommand: 'retrieve_and_generate',
  RetrieveAndGenerateStreamCommand: 'retrieve_and_generate_stream',
};

const KNOWLEDGE_BASE_SYSTEM = 'bedrock-knowledge-base';

function agentOp(command: unknown): AgentOp | undefined {
  if (!command || typeof command !== 'object') return undefined;
  const ctor = (command as any).constructor?.name ?? '';
  return AGENT_OPS[ctor];
}

function generateConfigModel(input: any): string | undefined {
  const config = input?.retrieveAndGenerateConfiguration;
  const modelArn =
    config?.knowledgeBaseConfiguration?.modelArn ?? config?.externalSourcesConfiguration?.modelArn;
  return typeof modelArn === 'string' && modelArn ? modelArn : undefined;
}

function knowledgeBaseId(input: any): string | undefined {
  const id =
    input?.knowledgeBaseId ??
    input?.retrieveAndGenerateConfiguration?.knowledgeBaseConfiguration?.knowledgeBaseId;
  return typeof id === 'string' && id ? id : undefined;
}

function agentPrompt(op: AgentOp, input: any): string {
  if (op === 'retrieve_and_generate' || op === 'retrieve_and_generate_stream') {
    return typeof input?.input?.text === 'string' ? input.input.text : '';
  }
  return typeof input?.inputText === 'string' ? input.inputText : '';
}

function startAgentSpan(
  client: EvalKitClient,
  op: AgentOp,
  input: any,
  ctx: OtelContext,
): Span {
  const model = op === 'invoke_inline_agent'
    ? (typeof input?.foundationModel === 'string' ? input.foundationModel : undefined)
    : generateConfigModel(input);
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined;
  const kbId = knowledgeBaseId(input);
  const promptText = agentPrompt(op, input);

  const span = client.tracer.startSpan(
    op,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'evalkit.span_type': 'llm_call',
        'gen_ai.system': BEDROCK_PROVIDER,
        ...(model && { 'gen_ai.request.model': model }),
        ...(sessionId && { 'gen_ai.conversation.id': sessionId, 'evalkit.session_id': sessionId }),
        ...(kbId && { 'aws.bedrock.knowledge_base.id': kbId }),
        'evalkit.prompt': promptText,
      },
    },
    ctx,
  );

  const reqBody = safeBody(input);
  if (reqBody) span.setAttribute('gen_ai.request.body', reqBody);
  return span;
}

function traceAgentStream(
  client: EvalKitClient,
  span: Span,
  result: any,
  preferredKey: string,
  readText: (event: any) => string,
  fallbackModel: string,
  startMs: number,
): unknown {
  const found = findEventStream(result, preferredKey);
  if (!found) {
    applyResponse(client, span, {}, fallbackModel, { streaming: true });
    endSpan(span);
    return result;
  }

  let completion = '';
  let ttftMs: number | undefined;
  let streamError: Error | undefined;
  let finished = false;

  const onEvent = (event: any) => {
    const err = streamException(event, AGENT_STREAM_EXCEPTIONS);
    if (err) streamError = err;
    const text = readText(event);
    if (text) {
      if (ttftMs === undefined) ttftMs = Date.now() - startMs;
      completion += text;
    }
  };

  const onDone = (error?: Error) => {
    if (finished) return;
    finished = true;
    const failure = error ?? streamError;
    applyResponse(client, span, { completion }, fallbackModel, { streaming: true, ttftMs, error: failure });
    endSpan(span);
  };

  return replaceMember(result, found.key, teeAsyncIterable(found.stream, onEvent, onDone));
}

function agentChunkText(event: any): string {
  return decodeBlob(event?.chunk?.bytes) ?? '';
}

function generateStreamText(event: any): string {
  const text = event?.output?.text;
  return typeof text === 'string' ? text : '';
}

async function traceRetrieve(
  client: EvalKitClient,
  original: (...args: unknown[]) => Promise<unknown>,
  self: unknown,
  args: unknown[],
  input: any,
): Promise<unknown> {
  let end: ReturnType<typeof startVectorDb>;
  try {
    end = startVectorDb(client, KNOWLEDGE_BASE_SYSTEM, 'retrieve', 'retrieve');
  } catch {
    return original.apply(self, args);
  }

  let result: any;
  try {
    result = await original.apply(self, args);
  } catch (err) {
    end('ERROR', undefined, err);
    throw err;
  }

  const attrs: Record<string, string | number | boolean> = {};
  try {
    const kbId = knowledgeBaseId(input);
    if (kbId) attrs['aws.bedrock.knowledge_base.id'] = kbId;
    const query = input?.retrievalQuery?.text;
    if (typeof query === 'string' && query) attrs['evalkit.prompt'] = query;
    const results = Array.isArray(result?.retrievalResults) ? result.retrievalResults : [];
    attrs['db.vector.match_count'] = results.length;
    const reqBody = safeBody(input);
    if (reqBody) attrs['gen_ai.request.body'] = reqBody;
    const respBody = safeBody({ retrievalResults: results, guardrailAction: result?.guardrailAction });
    if (respBody) attrs['gen_ai.response.body'] = respBody;
  } catch {  }
  end('OK', attrs);
  return result;
}

export function patchBedrockAgentRuntime(
  client: EvalKitClient,
  agentClient: AgentClient,
  parentCtx?: OtelContext,
): void {
  if (typeof agentClient?.send !== 'function') return;
  if ((agentClient.send as any).__evalkit) return;

  const original = agentClient.send;

  agentClient.send = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const command = args[0] as any;
    const op = agentOp(command);
    if (!op) return original.apply(this, args);

    const input = command?.input;

    if (op === 'retrieve') return traceRetrieve(client, original, this, args, input);

    let span: Span;
    let spanCtx: OtelContext;
    const startMs = Date.now();
    try {
      const ctx = parentCtx ?? otelContext.active();
      span = startAgentSpan(client, op, input, ctx);
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

    const fallbackModel = op === 'invoke_inline_agent'
      ? (typeof input?.foundationModel === 'string' ? input.foundationModel : '')
      : (generateConfigModel(input) ?? '');

    if (op === 'invoke_agent' || op === 'invoke_inline_agent') {
      return traceAgentStream(client, span, result, 'completion', agentChunkText, fallbackModel, startMs);
    }

    if (op === 'retrieve_and_generate_stream') {
      return traceAgentStream(client, span, result, 'stream', generateStreamText, fallbackModel, startMs);
    }

    const completion = typeof result?.output?.text === 'string' ? result.output.text : '';
    applyResponse(client, span, { completion }, fallbackModel, { responseBody: result });
    endSpan(span);
    return result;
  };

  (agentClient.send as any).__evalkit = true;
}
