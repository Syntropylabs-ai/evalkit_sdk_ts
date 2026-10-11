/**
 * A message's content as readable text, in any of the shapes providers and frameworks use: a string as it
 * is; content blocks (`[{"type": "text", "text": ...}]` for OpenAI and Anthropic, `[{"text": ...}]` for
 * Bedrock and Strands, `{"type": "text", "content": ...}` parts for the latest GenAI convention) as their
 * text, one block per line. A block that is not text (a tool call, a tool result, structured JSON) is kept
 * as JSON and an image or file block is named, so a prompt never reads "[object Object]" and never carries
 * an inline base64 payload.
 */
export function messageContentText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => blockText(block))
      .filter((text) => text !== "")
      .join("\n");
  }
  if (typeof content === "object") return blockText(content);
  return String(content);
}

const TEXT_TYPES = /^(text|input_text|output_text)$/;
const MEDIA_TYPES = /^(image|image_url|input_image|input_audio|audio|file|input_file|document|video)$/;
const MEDIA_KEYS = ["image", "document", "video", "audio"];

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block === undefined || block === null) return "";
  if (typeof block !== "object") return String(block);
  const b = block as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : undefined;
  if (type === undefined || TEXT_TYPES.test(type)) {
    if (typeof b.text === "string") return b.text;
    if (typeof b.content === "string" && type !== undefined) return b.content;
  }
  if (type !== undefined && MEDIA_TYPES.test(type)) return `[${type}]`;
  const media = MEDIA_KEYS.find((key) => b[key] !== undefined && type === undefined);
  if (media) return `[${media}]`;
  try {
    return JSON.stringify(block);
  } catch {
    return "";
  }
}

/** A JSON array, object or string literal parsed; any other value, or text that is not JSON, as it is. */
export function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{") && !trimmed.startsWith('"')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
