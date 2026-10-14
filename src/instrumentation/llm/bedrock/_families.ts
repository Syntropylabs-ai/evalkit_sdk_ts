import { fromAnthropicBlocks, fromOpenAIChat } from "../_toolcalls.js";
import { StreamToolCalls } from "../_stream.js";
import type { NormalizedToolCall } from "../_toolcalls.js";

export type BedrockFamily =
  | 'anthropic'
  | 'nova'
  | 'titan'
  | 'titan-embed'
  | 'meta'
  | 'mistral-chat'
  | 'mistral'
  | 'cohere-r'
  | 'cohere'
  | 'cohere-embed'
  | 'jamba'
  | 'jurassic'
  | 'deepseek'
  | 'unknown';

export type BedrockUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type BedrockResponseInfo = BedrockUsage & {
  completion?: string;
  thinking?: string;
  hasRedactedThinking?: boolean;
  finishReason?: string;
  responseId?: string;
  responseModel?: string;
  toolCalls?: NormalizedToolCall[];
};

export type BedrockRequestInfo = {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

export type BedrockStreamSnapshot = BedrockResponseInfo & { firstTextMs?: number };

export type BedrockStreamAccumulator = {
  push: (chunk: any) => void;
  snapshot: () => BedrockStreamSnapshot;
};

const INFERENCE_PROFILE_PREFIXES = ['us-gov.', 'us.', 'eu.', 'jp.', 'apac.', 'global.'];

export function normalizeModelId(modelId: string): string {
  let id = modelId;
  if (id.startsWith('arn:')) {
    const slash = id.lastIndexOf('/');
    if (slash >= 0) id = id.slice(slash + 1);
  }
  for (const prefix of INFERENCE_PROFILE_PREFIXES) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

export function detectFamily(modelId: string): BedrockFamily {
  const id = normalizeModelId(modelId);
  if (id.startsWith('anthropic.claude')) return 'anthropic';
  if (id.startsWith('amazon.nova')) return 'nova';
  if (id.startsWith('amazon.titan-embed')) return 'titan-embed';
  if (id.startsWith('amazon.titan-text')) return 'titan';
  if (id.startsWith('meta.llama')) return 'meta';
  if (id.startsWith('mistral.mistral-large')) return 'mistral-chat';
  if (id.startsWith('mistral.')) return 'mistral';
  if (id.startsWith('cohere.command-r')) return 'cohere-r';
  if (id.startsWith('cohere.command')) return 'cohere';
  if (id.startsWith('cohere.embed')) return 'cohere-embed';
  if (id.startsWith('ai21.jamba')) return 'jamba';
  if (id.startsWith('ai21.j2')) return 'jurassic';
  if (id.startsWith('deepseek.')) return 'deepseek';
  return 'unknown';
}

export function decodeBlob(blob: unknown): string | undefined {
  if (blob == null) return undefined;
  if (typeof blob === 'string') return blob;
  try {
    if (blob instanceof Uint8Array) return new TextDecoder().decode(blob);
    if (blob instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(blob));
  } catch {  }
  return undefined;
}

export function parseJsonBlob(blob: unknown): any {
  const text = decodeBlob(blob);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block: any) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
      .join('');
  }
  if (value && typeof (value as any).text === 'string') return (value as any).text;
  return '';
}

function messageLines(messages: unknown, contentKey: string): string[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m: any) => `${m?.role ?? 'message'}: ${textOf(m?.[contentKey])}`);
}

function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((l): l is string => !!l).join('\n');
}

function systemLine(value: unknown): string | undefined {
  const text = textOf(value);
  return text ? `system: ${text}` : undefined;
}

export function parseInvokeRequest(family: BedrockFamily, body: any): BedrockRequestInfo {
  if (!body || typeof body !== 'object') return { prompt: '' };

  switch (family) {
    case 'anthropic':
      return {
        prompt: joinLines([systemLine(body.system), ...messageLines(body.messages, 'content')]),
        maxTokens: num(body.max_tokens),
      };
    case 'nova':
      return {
        prompt: joinLines([systemLine(body.system), ...messageLines(body.messages, 'content')]),
        maxTokens: num(body.inferenceConfig?.maxTokens),
        temperature: num(body.inferenceConfig?.temperature),
        topP: num(body.inferenceConfig?.topP),
      };
    case 'titan':
      return {
        prompt: textOf(body.inputText),
        maxTokens: num(body.textGenerationConfig?.maxTokenCount),
        temperature: num(body.textGenerationConfig?.temperature),
        topP: num(body.textGenerationConfig?.topP),
      };
    case 'titan-embed':
      return { prompt: textOf(body.inputText) };
    case 'meta':
      return {
        prompt: textOf(body.prompt),
        maxTokens: num(body.max_gen_len),
        temperature: num(body.temperature),
        topP: num(body.top_p),
      };
    case 'mistral':
      return { prompt: textOf(body.prompt), maxTokens: num(body.max_tokens) };
    case 'mistral-chat':
      return {
        prompt: joinLines(messageLines(body.messages, 'content')),
        maxTokens: num(body.max_tokens),
      };
    case 'cohere':
      return { prompt: textOf(body.prompt), maxTokens: num(body.max_tokens) };
    case 'cohere-r':
      return {
        prompt: joinLines([
          systemLine(body.preamble),
          ...messageLines(body.chat_history, 'message'),
          str(body.message) ? `user: ${textOf(body.message)}` : undefined,
        ]),
        maxTokens: num(body.max_tokens),
      };
    case 'cohere-embed':
      return { prompt: Array.isArray(body.texts) ? body.texts.map((t: unknown) => textOf(t)).join('\n') : '' };
    case 'jamba':
      return {
        prompt: joinLines(messageLines(body.messages, 'content')),
        maxTokens: num(body.max_tokens),
      };
    case 'jurassic':
      return { prompt: textOf(body.prompt), maxTokens: num(body.maxTokens) };
    case 'deepseek':
      return { prompt: textOf(body.prompt), maxTokens: num(body.max_tokens) };
    default:
      return { prompt: '' };
  }
}

function anthropicResponse(body: any): BedrockResponseInfo {
  const content: any[] = Array.isArray(body.content) ? body.content : [];
  const completion = content
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => str(block?.text) ?? '')
    .join('');
  const thinking = content
    .filter((block: any) => block?.type === 'thinking')
    .map((block: any) => str(block?.thinking) ?? '')
    .join('');
  return {
    completion,
    ...(thinking && { thinking }),
    inputTokens: num(body.usage?.input_tokens),
    outputTokens: num(body.usage?.output_tokens),
    cacheReadTokens: num(body.usage?.cache_read_input_tokens),
    cacheWriteTokens: num(body.usage?.cache_creation_input_tokens),
    finishReason: str(body.stop_reason),
    responseId: str(body.id),
    toolCalls: fromAnthropicBlocks(content),
  };
}

function novaResponse(body: any): BedrockResponseInfo {
  const content: any[] = Array.isArray(body.output?.message?.content) ? body.output.message.content : [];
  return {
    completion: content.map((block: any) => str(block?.text) ?? '').join(''),
    inputTokens: num(body.usage?.inputTokens),
    outputTokens: num(body.usage?.outputTokens),
    totalTokens: num(body.usage?.totalTokens),
    cacheReadTokens: num(body.usage?.cacheReadInputTokens) ?? num(body.usage?.cacheReadInputTokenCount),
    cacheWriteTokens: num(body.usage?.cacheWriteInputTokens) ?? num(body.usage?.cacheWriteInputTokenCount),
    finishReason: str(body.stopReason),
  };
}

function titanResponse(body: any): BedrockResponseInfo {
  const results: any[] = Array.isArray(body.results) ? body.results : [];
  const outputTokens = results.reduce<number | undefined>((acc, r) => {
    const count = num(r?.tokenCount);
    return count === undefined ? acc : (acc ?? 0) + count;
  }, undefined);
  return {
    completion: results.map((r: any) => str(r?.outputText) ?? '').join(''),
    inputTokens: num(body.inputTextTokenCount),
    outputTokens,
    finishReason: str(results[0]?.completionReason),
  };
}

function metaResponse(body: any): BedrockResponseInfo {
  return {
    completion: str(body.generation) ?? '',
    inputTokens: num(body.prompt_token_count),
    outputTokens: num(body.generation_token_count),
    finishReason: str(body.stop_reason),
  };
}

function mistralResponse(body: any): BedrockResponseInfo {
  const outputs: any[] = Array.isArray(body.outputs) ? body.outputs : [];
  return {
    completion: outputs.map((o: any) => str(o?.text) ?? '').join(''),
    finishReason: str(outputs[0]?.stop_reason),
  };
}

function mistralChatResponse(body: any): BedrockResponseInfo {
  const choices: any[] = Array.isArray(body.choices) ? body.choices : [];
  return {
    completion: choices.map((c: any) => str(c?.message?.content) ?? '').join(''),
    finishReason: str(choices[0]?.stop_reason),
    toolCalls: fromOpenAIChat(body),
  };
}

function cohereResponse(body: any): BedrockResponseInfo {
  const generations: any[] = Array.isArray(body.generations) ? body.generations : [];
  return {
    completion: generations.map((g: any) => str(g?.text) ?? '').join(''),
    finishReason: str(generations[0]?.finish_reason),
  };
}

function cohereRResponse(body: any): BedrockResponseInfo {
  return {
    completion: str(body.text) ?? '',
    inputTokens: num(body.meta?.billed_units?.input_tokens),
    outputTokens: num(body.meta?.billed_units?.output_tokens),
    finishReason: str(body.finish_reason),
  };
}

function jambaResponse(body: any): BedrockResponseInfo {
  const choices: any[] = Array.isArray(body.choices) ? body.choices : [];
  return {
    completion: choices.map((c: any) => str(c?.message?.content) ?? '').join(''),
    inputTokens: num(body.usage?.prompt_tokens),
    outputTokens: num(body.usage?.completion_tokens),
    totalTokens: num(body.usage?.total_tokens),
    finishReason: str(choices[0]?.finish_reason),
  };
}

function jurassicResponse(body: any): BedrockResponseInfo {
  const completions: any[] = Array.isArray(body.completions) ? body.completions : [];
  return { completion: completions.map((c: any) => str(c?.data?.text) ?? '').join('') };
}

function deepseekResponse(body: any): BedrockResponseInfo {
  const choices: any[] = Array.isArray(body.choices) ? body.choices : [];
  return {
    completion: choices.map((c: any) => str(c?.text) ?? '').join(''),
    finishReason: str(choices[0]?.stop_reason),
  };
}

export function parseInvokeResponse(family: BedrockFamily, body: any): BedrockResponseInfo {
  if (!body || typeof body !== 'object') return {};
  try {
    switch (family) {
      case 'anthropic':
        return anthropicResponse(body);
      case 'nova':
        return novaResponse(body);
      case 'titan':
      case 'titan-embed':
        return titanResponse(body);
      case 'meta':
        return metaResponse(body);
      case 'mistral':
        return mistralResponse(body);
      case 'mistral-chat':
        return mistralChatResponse(body);
      case 'cohere':
        return cohereResponse(body);
      case 'cohere-r':
        return cohereRResponse(body);
      case 'jamba':
        return jambaResponse(body);
      case 'jurassic':
        return jurassicResponse(body);
      case 'deepseek':
        return deepseekResponse(body);
      default:
        return {};
    }
  } catch {
    return {};
  }
}

export function createInvokeStreamAccumulator(family: BedrockFamily): BedrockStreamAccumulator {
  const info: BedrockResponseInfo = {};
  let completion = '';
  let thinking = '';
  let firstTextMs: number | undefined;
  const tools = new StreamToolCalls();

  const setNumber = (key: keyof BedrockUsage, value: number | undefined) => {
    if (value !== undefined) info[key] = value;
  };

  const setFallback = (key: keyof BedrockUsage, value: number | undefined) => {
    if (value !== undefined && info[key] === undefined) info[key] = value;
  };

  function invocationMetrics(chunk: any): void {
    const metrics = chunk?.['amazon-bedrock-invocationMetrics'];
    if (!metrics) return;
    setFallback('cacheReadTokens', num(metrics.cacheReadInputTokenCount));
    setFallback('cacheWriteTokens', num(metrics.cacheWriteInputTokenCount));
    setFallback('inputTokens', num(metrics.inputTokenCount));
    setFallback('outputTokens', num(metrics.outputTokenCount));
  }

  function pushAnthropic(chunk: any): void {
    const type = chunk?.type;
    if (type === 'message_start') {
      setNumber('inputTokens', num(chunk?.message?.usage?.input_tokens));
      setNumber('outputTokens', num(chunk?.message?.usage?.output_tokens));
      setNumber('cacheReadTokens', num(chunk?.message?.usage?.cache_read_input_tokens));
      setNumber('cacheWriteTokens', num(chunk?.message?.usage?.cache_creation_input_tokens));
    } else if (type === 'content_block_start') {
      const block = chunk?.content_block;
      if (block?.type === 'tool_use') {
        const entry = tools.entry(String(chunk?.index ?? 0));
        tools.describe(entry, block.name, block.id);
        if (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) {
          tools.setArguments(entry, block.input);
        }
      }
    } else if (type === 'content_block_delta') {
      const delta = chunk?.delta;
      if (delta?.type === 'text_delta') completion += str(delta.text) ?? '';
      else if (delta?.type === 'thinking_delta') thinking += str(delta.thinking) ?? '';
      else if (delta?.type === 'input_json_delta') tools.appendArguments(tools.entry(String(chunk?.index ?? 0)), delta.partial_json);
    } else if (type === 'message_delta') {
      const reason = str(chunk?.delta?.stop_reason);
      if (reason) info.finishReason = reason;
      setNumber('outputTokens', num(chunk?.usage?.output_tokens));
    }
  }

  function pushTitan(chunk: any): void {
    completion += str(chunk?.outputText) ?? '';
    setNumber('inputTokens', num(chunk?.inputTextTokenCount));
    setNumber('outputTokens', num(chunk?.totalOutputTextTokenCount));
    const reason = str(chunk?.completionReason);
    if (reason) info.finishReason = reason;
  }

  function pushNova(chunk: any): void {
    completion += str(chunk?.contentBlockDelta?.delta?.text) ?? '';
    setNumber('inputTokens', num(chunk?.metadata?.usage?.inputTokens));
    setNumber('outputTokens', num(chunk?.metadata?.usage?.outputTokens));
    setNumber('totalTokens', num(chunk?.metadata?.usage?.totalTokens));
    setNumber('cacheReadTokens', num(chunk?.metadata?.usage?.cacheReadInputTokens));
    setNumber('cacheWriteTokens', num(chunk?.metadata?.usage?.cacheWriteInputTokens));
  }

  function pushGeneric(chunk: any): void {
    const partial = parseInvokeResponse(family, chunk);
    completion += partial.completion ?? '';
    setNumber('inputTokens', partial.inputTokens);
    setNumber('outputTokens', partial.outputTokens);
    setNumber('totalTokens', partial.totalTokens);
    if (partial.finishReason) info.finishReason = partial.finishReason;
    if (partial.responseId) info.responseId = partial.responseId;
    if (partial.responseModel) info.responseModel = partial.responseModel;
  }

  return {
    push(chunk: any): void {
      if (family === 'anthropic') pushAnthropic(chunk);
      else if (family === 'titan' || family === 'titan-embed') pushTitan(chunk);
      else if (family === 'nova') pushNova(chunk);
      else pushGeneric(chunk);
      invocationMetrics(chunk);
      if (firstTextMs === undefined && (completion.length > 0 || thinking.length > 0)) firstTextMs = Date.now();
    },
    snapshot(): BedrockStreamSnapshot {
      const toolCalls = tools.calls();
      return {
        ...info,
        completion,
        ...(thinking && { thinking }),
        ...(firstTextMs !== undefined && { firstTextMs }),
        ...(toolCalls.length > 0 && { toolCalls }),
      };
    },
  };
}
