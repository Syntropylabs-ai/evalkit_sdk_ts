export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GoogleUsage {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cachedTokens: number;
  toolUseTokens: number;
  reasoningTokens: number;
}

export const EMPTY_GOOGLE_USAGE: GoogleUsage = {
  tokensIn: 0,
  tokensOut: 0,
  totalTokens: 0,
  cachedTokens: 0,
  toolUseTokens: 0,
  reasoningTokens: 0,
};

export function extractGoogleUsage(meta?: GoogleUsageMetadata | null): GoogleUsage {
  if (!meta) return EMPTY_GOOGLE_USAGE;
  const prompt = meta.promptTokenCount ?? 0;
  const candidates = meta.candidatesTokenCount || meta.responseTokenCount || 0;
  const cachedTokens = meta.cachedContentTokenCount ?? 0;
  const toolUseTokens = meta.toolUsePromptTokenCount ?? 0;
  const reasoningTokens = meta.thoughtsTokenCount ?? 0;
  const tokensIn = prompt + toolUseTokens;
  const tokensOut = candidates + reasoningTokens;
  return {
    tokensIn,
    tokensOut,
    totalTokens: meta.totalTokenCount || tokensIn + tokensOut,
    cachedTokens,
    toolUseTokens,
    reasoningTokens,
  };
}

export function mergeGoogleUsage(prev: GoogleUsage, cur: GoogleUsage): GoogleUsage {
  return {
    tokensIn: cur.tokensIn || prev.tokensIn,
    tokensOut: cur.tokensOut || prev.tokensOut,
    totalTokens: cur.totalTokens || prev.totalTokens,
    cachedTokens: cur.cachedTokens || prev.cachedTokens,
    toolUseTokens: cur.toolUseTokens || prev.toolUseTokens,
    reasoningTokens: cur.reasoningTokens || prev.reasoningTokens,
  };
}

export function googleUsageAttributes(usage: GoogleUsage): Record<string, number> {
  const attrs: Record<string, number> = {
    'gen_ai.usage.input_tokens': usage.tokensIn,
    'gen_ai.usage.output_tokens': usage.tokensOut,
    'gen_ai.usage.total_tokens': usage.totalTokens,
  };
  if (usage.cachedTokens) attrs['gen_ai.usage.cached_tokens'] = usage.cachedTokens;
  if (usage.toolUseTokens) attrs['gen_ai.usage.tool_use_prompt_tokens'] = usage.toolUseTokens;
  if (usage.reasoningTokens) attrs['gen_ai.usage.reasoning_tokens'] = usage.reasoningTokens;
  return attrs;
}
