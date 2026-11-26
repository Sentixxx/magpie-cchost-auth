import {
  VALID_AGGREGATION_MODES,
  normalizeBaseUrl,
} from "./config.mjs"

function extractFromObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return []

  // Support { endpoints: [...] } wrapper
  if (Array.isArray(obj.endpoints)) {
    return obj.endpoints.flatMap((x) => extractFromObject(x))
  }

  // Support Claude Code ~/.claude/settings.json format:
  // { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
  const envObj = obj.env && typeof obj.env === "object" ? obj.env : null
  const baseUrlRaw =
    obj.baseUrl ??
    obj.base_url ??
    obj.url ??
    obj.endpoint ??
    envObj?.ANTHROPIC_BASE_URL ??
    envObj?.OPENAI_BASE_URL ??
    envObj?.CCHOST_BASE_URL ??
    ""
  const apiKeyRaw =
    obj.apiKey ??
    obj.api_key ??
    obj.key ??
    obj.token ??
    envObj?.ANTHROPIC_AUTH_TOKEN ??
    envObj?.ANTHROPIC_API_KEY ??
    envObj?.OPENAI_API_KEY ??
    envObj?.CCHOST_API_KEY ??
    ""

  const baseUrl = normalizeBaseUrl(String(baseUrlRaw ?? ""))
  const apiKey = String(apiKeyRaw ?? "").trim()
  if (!baseUrl && !apiKey) return []

  const rawAgg = String(obj.aggregation ?? "weighted").trim().toLowerCase()
  const aggregation = VALID_AGGREGATION_MODES.has(rawAgg) ? rawAgg : "weighted"

  return [
    {
      baseUrl,
      apiKey,
      label: typeof obj.label === "string" ? obj.label.trim() : typeof obj.name === "string" ? obj.name.trim() : "",
      aggregation,
      // Default false when splitting >1 nodes so Magpie shows "All N accounts"
      // instead of "All N+1 accounts". Set `includeEndpointCard: true` explicitly
      // if you also want a separate routing-only aggregated primary card.
      includeEndpointCard: obj.includeEndpointCard === true || obj.include_endpoint_card === true,
      includeOfflineNodes: obj.includeOfflineNodes !== false && obj.include_offline_nodes !== false,
    },
  ]
}

function parseKeyValueText(text) {
  const map = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const cleaned = line.replace(/^export\s+/i, "")
    const eq = cleaned.indexOf("=")
    if (eq <= 0) continue
    const k = cleaned.slice(0, eq).trim()
    let v = cleaned.slice(eq + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    map[k] = v
  }

  const baseUrl = normalizeBaseUrl(
    map.CCHOST_BASE_URL ??
      map.BASE_URL ??
      map.baseUrl ??
      map.base_url ??
      map.ANTHROPIC_BASE_URL ??
      map.OPENAI_BASE_URL ??
      "",
  )
  const apiKey = String(
    map.CCHOST_API_KEY ??
      map.API_KEY ??
      map.apiKey ??
      map.api_key ??
      map.ANTHROPIC_AUTH_TOKEN ??
      map.ANTHROPIC_API_KEY ??
      map.OPENAI_API_KEY ??
      "",
  ).trim()

  if (!baseUrl && !apiKey) return []
  const rawAgg = String(map.CCHOST_AGGREGATION ?? map.AGGREGATION ?? map.aggregation ?? "weighted")
    .trim()
    .toLowerCase()
  return [
    {
      baseUrl,
      apiKey,
      label: String(map.CCHOST_LABEL ?? map.LABEL ?? map.label ?? "").trim(),
      aggregation: VALID_AGGREGATION_MODES.has(rawAgg) ? rawAgg : "weighted",
      includeEndpointCard: String(map.INCLUDE_ENDPOINT_CARD ?? "false").toLowerCase() === "true",
      includeOfflineNodes: String(map.INCLUDE_OFFLINE_NODES ?? "true").toLowerCase() !== "false",
    },
  ]
}

/**
 * Parse one or more imported text files into CC Host endpoint specifications.
 * Supports:
 * - JSON object: `{ "baseUrl": "...", "apiKey": "...", "label": "..." }`
 * - JSON array of endpoint objects or `{ "endpoints": [...] }`
 * - Claude Code settings JSON: `{ "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." } }`
 * - `.env` / key=value lines (`BASE_URL=...`, `API_KEY=...`, `ANTHROPIC_BASE_URL=...`, etc.)
 */
export function parseImportedEndpoints(texts) {
  const specs = []
  const list = Array.isArray(texts) ? texts : [texts]

  for (const raw of list) {
    if (typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (!trimmed) continue

    let parsedJson = null
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsedJson = JSON.parse(trimmed)
      } catch {
        parsedJson = null
      }
    }

    if (parsedJson !== null) {
      if (Array.isArray(parsedJson)) {
        for (const item of parsedJson) specs.push(...extractFromObject(item))
      } else {
        specs.push(...extractFromObject(parsedJson))
      }
    } else {
      specs.push(...parseKeyValueText(trimmed))
    }
  }

  return specs
}
