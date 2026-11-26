import { PROVIDER_ID, normalizeAccountType } from "./config.mjs"

/**
 * Determine primary AI SDK `npm` package and `also` protocols for a model served
 * by CC Host, following https://cchost.ai/docs/api:
 *
 * - Anthropic Messages (`/v1/messages`): Claude / Cursor / Gemini / Grok / Kimi / Ollama / aistudio/ / openai/
 * - OpenAI Responses (`/v1/responses`): Codex / Grok / Kimi / Ollama / aistudio/ / openai/
 * - OpenAI Chat Completions (`/v1/chat/completions`): Grok / Kimi / Ollama / aistudio/ / openai/
 *
 * Notice Gemini accounts ONLY support `/v1/messages` on CC Host (never `/v1/responses`
 * or `/v1/chat/completions`), while Codex accounts serve `/v1/responses`.
 */
export function resolveModelProtocols(modelId, rawModel = {}) {
  const id = String(modelId ?? "").trim().toLowerCase()
  const ownedBy = normalizeAccountType(rawModel.owned_by ?? rawModel.provider ?? "")

  if (id.startsWith("aistudio/") || id.startsWith("openai/")) {
    return {
      npm: "@ai-sdk/openai-compatible",
      also: ["@ai-sdk/anthropic", "@ai-sdk/openai"],
    }
  }

  if (
    id.startsWith("claude/") ||
    id.startsWith("claude-") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku") ||
    id.includes("fable") ||
    id.includes("mythos")
  ) {
    return {
      npm: "@ai-sdk/anthropic",
      also: [],
    }
  }

  if (id.startsWith("gemini/") || id.startsWith("gemini-") || ownedBy === "gemini") {
    // CC Host Gemini subscription accounts only serve Anthropic Messages (`/v1/messages`)
    return {
      npm: "@ai-sdk/anthropic",
      also: [],
    }
  }

  if (
    id.startsWith("codex/") ||
    id.startsWith("gpt-5") ||
    id.startsWith("codex") ||
    /^o[134](-|$)/.test(id) ||
    ownedBy === "codex"
  ) {
    return {
      npm: "@ai-sdk/openai",
      also: [],
    }
  }

  if (
    id.startsWith("grok") ||
    id.startsWith("kimi") ||
    id.startsWith("moonshot") ||
    id.includes(":") ||
    ownedBy === "grok" ||
    ownedBy === "kimi" ||
    ownedBy === "ollama"
  ) {
    return {
      npm: "@ai-sdk/openai-compatible",
      also: ["@ai-sdk/anthropic", "@ai-sdk/openai"],
    }
  }

  // Fallback for Cursor or unknown models: Anthropic Messages + OpenAI compatible
  if (ownedBy === "cursor" || id.startsWith("cursor/")) {
    return {
      npm: "@ai-sdk/anthropic",
      also: [],
    }
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    also: ["@ai-sdk/anthropic", "@ai-sdk/openai"],
  }
}

function inferModelMetadata(modelId, rawModel = {}) {
  const id = String(modelId ?? "").toLowerCase()
  const isClaude =
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku") ||
    id.includes("fable") ||
    id.includes("mythos")
  const isCodex = id.startsWith("gpt-5") || id.includes("codex") || /^o[134](-|$)/.test(id)
  const isGemini = id.includes("gemini")
  const isReasoning =
    rawModel.reasoning !== undefined
      ? Boolean(rawModel.reasoning)
      : isClaude || isCodex || isGemini || id.includes("grok") || id.includes("kimi") || id.includes("r1")

  const context =
    Number(rawModel.context_window ?? rawModel.context_length ?? rawModel.limit?.context) ||
    (isGemini ? 1000000 : isCodex ? 400000 : isClaude ? 200000 : 128000)

  const output =
    Number(rawModel.max_output_tokens ?? rawModel.limit?.output) ||
    (isCodex ? 128000 : isClaude ? 64000 : 32768)

  const image =
    rawModel.capabilities?.input?.image !== undefined
      ? Boolean(rawModel.capabilities.input.image)
      : isClaude || isCodex || isGemini

  return {
    context,
    output,
    reasoning: isReasoning,
    image,
  }
}

/**
 * Convert CC Host `GET /v1/models` response into Magpie/OpenCode `provider.models` map.
 */
export function buildModelsMap(payload, baseUrl) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []

  const apiBase = baseUrl ? `${baseUrl}/v1` : ""
  const out = {}

  for (const item of list) {
    const id = typeof item === "string" ? item.trim() : String(item?.id ?? "").trim()
    if (!id) continue
    const raw = typeof item === "object" && item !== null ? item : {}
    const { npm, also } = resolveModelProtocols(id, raw)
    const meta = inferModelMetadata(id, raw)

    out[id] = {
      id,
      providerID: PROVIDER_ID,
      name: String(raw.display_name ?? raw.name ?? id).trim() || id,
      api: {
        id,
        url: apiBase,
        npm,
      },
      limit: {
        context: meta.context,
        output: meta.output,
      },
      capabilities: {
        temperature: true,
        reasoning: meta.reasoning,
        attachment: meta.image,
        toolcall: true,
        input: { text: true, image: meta.image },
        output: { text: true },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      variants: {},
      ...(also.length > 0 ? { also } : {}),
    }
  }

  return out
}
