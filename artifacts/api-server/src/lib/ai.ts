// Thin, optional Anthropic Messages client.
//
// The API key is read SERVER-SIDE ONLY from the ANTHROPIC_API_KEY environment
// variable. It is never sent to the browser and never logged. When the key is
// unset (or a call fails), callers degrade gracefully: the AI layer is purely
// advisory and the deterministic engine remains the single source of truth.

// Model identifiers live in ONE place.
export const AI_MODEL_STANDARD = "claude-sonnet-4-5";
export const AI_MODEL_DEEP = "claude-opus-4-8";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** True only when an Anthropic API key is configured server-side. */
export function isAiAvailable(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

export interface CallClaudeOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export type CallClaudeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Calls the Anthropic Messages API and returns the concatenated text content.
 * Never throws; on any failure (missing key, network, non-2xx, bad shape) it
 * returns { ok: false }. The key is only ever placed in the request header.
 */
export async function callClaude(
  opts: CallClaudeOptions,
): Promise<CallClaudeResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, error: "AI disabled: ANTHROPIC_API_KEY is not set" };
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 8192,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });

    if (!res.ok) {
      // Do not include the response body verbatim in case it echoes headers.
      return { ok: false, error: `Anthropic request failed (${res.status})` };
    }

    const data: unknown = await res.json();
    const text = extractText(data);
    if (text == null) {
      return { ok: false, error: "Anthropic returned an unexpected response" };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Could not reach the Anthropic API" };
  }
}

function extractText(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Extracts a JSON object from a model response, tolerating ```json fences and
 * surrounding prose. Returns null when no JSON object can be parsed.
 */
export function parseJsonObject(raw: string): unknown {
  let s = raw.trim();
  // Strip Markdown code fences if present.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1]) s = fence[1].trim();
  // Fall back to the outermost { ... } span.
  if (!s.startsWith("{")) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    s = s.slice(start, end + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
