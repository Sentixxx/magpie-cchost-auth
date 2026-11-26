export const PROVIDER_ID = "cchost"
export const PROVIDER_NAME = "CC Host"

export const FIVE_HOUR_SECS = 5 * 3600
export const SEVEN_DAY_SECS = 7 * 24 * 3600

export const VALID_AGGREGATION_MODES = new Set([
  "weighted",
  "min_used",
  "max_used",
  "average",
])

export const VALID_UTILIZATION_SCALES = new Set(["auto", "percent", "ratio"])

export const CANONICAL_ACCOUNT_TYPES = new Set([
  "claude",
  "codex",
  "gemini",
  "grok",
  "kimi",
  "cursor",
  "ollama",
  "aistudio",
  "openai",
])

export const ACCOUNT_TYPE_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  cursor: "Cursor",
  ollama: "Ollama",
  aistudio: "Google AI Studio",
  openai: "OpenAI",
}

// Relative capacity weights inferred when CC Host does not include an explicit
// numeric `weight` on a node. Explicit API weights and user overrides always win.
export const DEFAULT_TIER_WEIGHTS = {
  // Claude plans
  "claude:max_20x": 20,
  "claude:max20x": 20,
  "claude:max_20": 20,
  "claude:max_5x": 5,
  "claude:max5x": 5,
  "claude:max_5": 5,
  "claude:max": 5,
  "claude:team_premium": 5,
  "claude:team": 1.25,
  "claude:enterprise": 5,
  "claude:pro": 1,
  "claude:free": 0.25,

  // Codex / ChatGPT plans
  "codex:pro": 10,
  "codex:team": 1.5,
  "codex:business": 1.5,
  "codex:plus": 1,
  "codex:free": 0.25,

  // Gemini plans
  "gemini:ultra": 10,
  "gemini:ai_ultra": 10,
  "gemini:pro": 1,
  "gemini:ai_pro": 1,
  "gemini:free": 0.25,

  // Grok plans
  "grok:supergrok_heavy": 10,
  "grok:heavy": 10,
  "grok:supergrok": 2,
  "grok:pro": 2,
  "grok:plus": 1,
  "grok:free": 0.25,

  // Kimi / Cursor / Ollama
  "kimi:ultra": 10,
  "kimi:max": 5,
  "kimi:pro": 1,
  "cursor:ultra": 10,
  "cursor:pro_plus": 3,
  "cursor:pro": 1,
  "cursor:business": 2,
  "ollama:max": 5,
  "ollama:pro": 1,
}

/**
 * Normalize a CC Host endpoint Base URL:
 * - validates http:// or https://
 * - strips query/hash
 * - strips trailing slashes and a trailing `/v1` segment
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return ""
  const trimmed = raw.trim()
  if (!trimmed) return ""
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return ""
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
  let pathname = parsed.pathname.replace(/\/+$/, "")
  if (pathname.toLowerCase().endsWith("/v1")) {
    pathname = pathname.slice(0, -3).replace(/\/+$/, "")
  }
  return `${parsed.origin}${pathname}`
}

export function validateBaseUrl(raw) {
  const normalized = normalizeBaseUrl(raw)
  if (!normalized) {
    return "Enter a valid http:// or https:// CC Host endpoint Base URL"
  }
  return undefined
}

export function defaultEndpointLabel(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return "cchost"
  try {
    const u = new URL(normalized)
    const slug = u.pathname.replace(/^\/+|\/+$/g, "")
    return slug ? `${u.host}/${slug}` : u.host
  } catch {
    return normalized
  }
}

export function normalizeAccountType(raw) {
  if (typeof raw !== "string") return "unknown"
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!s) return "unknown"
  if (
    s === "claude" ||
    s === "anthropic" ||
    s.startsWith("claude_") ||
    s.includes("claude")
  ) {
    return "claude"
  }
  if (s === "codex" || s === "chatgpt" || s.startsWith("codex_")) {
    return "codex"
  }
  if (
    s === "aistudio" ||
    s === "ai_studio" ||
    s === "google_ai_studio" ||
    s === "googleaistudio"
  ) {
    return "aistudio"
  }
  if (s === "gemini" || s === "google" || s.startsWith("gemini_")) {
    return "gemini"
  }
  if (s === "grok" || s === "xai") return "grok"
  if (s === "kimi" || s === "moonshot") return "kimi"
  if (s === "cursor") return "cursor"
  if (s === "ollama" || s === "ollama_cloud") return "ollama"
  if (s === "openai" || s === "openai_api") return "openai"
  return s
}

export function normalizePlanKey(plan) {
  if (typeof plan !== "string") return ""
  return plan
    .trim()
    .toLowerCase()
    .replace(/\(([^)]*)\)/g, " $1 ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function inferTierWeight(accountType, plan, userTierWeights = {}) {
  const type = normalizeAccountType(accountType)
  const planKey = normalizePlanKey(plan)
  if (!planKey) return null

  const merged = { ...DEFAULT_TIER_WEIGHTS }
  if (userTierWeights && typeof userTierWeights === "object") {
    for (const [k, v] of Object.entries(userTierWeights)) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) {
        merged[k.trim().toLowerCase()] = n
      }
    }
  }

  const exact = merged[`${type}:${planKey}`] ?? merged[planKey]
  if (exact) return exact

  // Pattern match common multiplier notations such as "Max 20x", "Max (5x)", "Pro 2x"
  const mult = planKey.match(/(?:^|_)(\d+(?:\.\d+)?)x(?:$|_)/)
  if (mult) {
    const n = Number(mult[1])
    if (Number.isFinite(n) && n > 0) return n
  }

  // Fuzzy prefix/substring match against tier keys for the same account type
  const candidates = Object.entries(merged)
    .filter(([k]) => k.startsWith(`${type}:`))
    .map(([k, v]) => [k.slice(type.length + 1), v])
    .sort((a, b) => b[0].length - a[0].length)

  for (const [suffix, weight] of candidates) {
    if (planKey === suffix || planKey.includes(suffix)) return weight
  }
  return null
}

/**
 * Resolve effective per-account configuration from saved auth metadata,
 * package options (`plugins.json`), and runtime Magpie switches (`auth.options`).
 */
export function resolveAccountConfig(auth, pluginOptions = {}, optionSwitches = {}) {
  const md = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const opts = pluginOptions && typeof pluginOptions === "object" ? pluginOptions : {}

  const baseUrl = normalizeBaseUrl(md.baseUrl ?? opts.baseUrl ?? "")
  const apiKey = typeof auth?.key === "string" ? auth.key.trim() : ""
  const label =
    (typeof md.label === "string" && md.label.trim()) ||
    (typeof md.email === "string" && md.email.trim()) ||
    defaultEndpointLabel(baseUrl)

  const rawAgg = String(
    md.aggregation ?? opts.aggregation ?? "weighted",
  ).trim().toLowerCase()
  const aggregation = VALID_AGGREGATION_MODES.has(rawAgg) ? rawAgg : "weighted"

  const rawScale = String(
    md.utilizationScale ?? opts.utilizationScale ?? "auto",
  ).trim().toLowerCase()
  const utilizationScale = VALID_UTILIZATION_SCALES.has(rawScale)
    ? rawScale
    : "auto"

  const crossWindowCoupling =
    typeof opts.crossWindowCoupling === "boolean"
      ? opts.crossWindowCoupling
      : typeof md.crossWindowCoupling === "boolean"
        ? md.crossWindowCoupling
        : true

  const role = md.role === "node" ? "node" : "endpoint"
  const nodeId = typeof md.nodeId === "string" ? md.nodeId.trim() : ""
  const nodeName = typeof md.nodeName === "string" ? md.nodeName.trim() : ""
  const splitCards = md.splitCards === true
  const usageOnly = md.usageOnly === true || (role === "node" && md.usageOnly !== false)

  const showNodeBreakdown = splitCards
    ? opts.showNodeBreakdown === true
    : typeof optionSwitches.show_node_breakdown === "boolean"
      ? optionSwitches.show_node_breakdown
      : typeof opts.showNodeBreakdown === "boolean"
        ? opts.showNodeBreakdown
        : true

  const forceGlobalWindows =
    optionSwitches.force_global_windows === true ||
    opts.forceGlobalWindows === true

  const includePaygNote =
    typeof opts.includePaygNote === "boolean" ? opts.includePaygNote : true

  const timeoutRaw = Number(opts.requestTimeoutMs)
  const requestTimeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 && timeoutRaw <= 120000
      ? timeoutRaw
      : 15000

  const nodeWeights =
    opts.nodeWeights && typeof opts.nodeWeights === "object"
      ? opts.nodeWeights
      : {}

  const tierWeights =
    opts.tierWeights && typeof opts.tierWeights === "object"
      ? opts.tierWeights
      : {}

  return {
    baseUrl,
    apiKey,
    label,
    role,
    nodeId,
    nodeName,
    splitCards,
    usageOnly,
    aggregation,
    utilizationScale,
    crossWindowCoupling,
    showNodeBreakdown,
    forceGlobalWindows,
    includePaygNote,
    requestTimeoutMs,
    nodeWeights,
    tierWeights,
  }
}
