import {
  FIVE_HOUR_SECS,
  SEVEN_DAY_SECS,
  inferTierWeight,
  normalizeAccountType,
} from "./config.mjs"

const READY_STATUSES = new Set([
  "",
  "ready",
  "online",
  "active",
  "healthy",
  "ok",
  "available",
  "normal",
  "idle",
  "running",
  "connected",
])

const EXHAUSTED_STATUSES = new Set([
  "quota_exhausted",
  "exhausted",
  "full",
  "limit_reached",
  "rate_limited",
  "quota_full",
  "limited",
  "throttled",
  "cooldown",
])

const COLLECTING_STATUSES = new Set([
  "collecting",
  "unknown",
  "pending_quota",
  "syncing",
])

const UNAVAILABLE_STATUSES = new Set([
  "offline",
  "paused",
  "suspended",
  "needs_login",
  "login_required",
  "pending_login",
  "preparing",
  "warming",
  "warmup",
  "error",
  "failed",
  "abnormal",
  "disabled",
  "removed",
  "deleted",
  "invalid_key",
  "insufficient_balance",
  "unhealthy",
])

export function parseTimestampMs(v) {
  if (v === undefined || v === null || v === "") return null
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return null
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === "string") {
    const trimmed = v.trim()
    if (!trimmed) return null
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n <= 0) return null
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
    }
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function finiteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}

function positiveNumber(v) {
  const n = finiteNumber(v)
  return n !== null && n > 0 ? n : null
}

function nonNegativeInt(v) {
  const n = finiteNumber(v)
  return n !== null && n >= 0 ? Math.floor(n) : null
}

function normalizeStatus(rawStatus, node) {
  const s = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase().replace(/[\s-]+/g, "_") : ""
  if (node?.disabled === true || node?.enabled === false) return "unavailable"
  if (EXHAUSTED_STATUSES.has(s)) return "quota_exhausted"
  if (UNAVAILABLE_STATUSES.has(s)) return "unavailable"
  if (COLLECTING_STATUSES.has(s)) return "collecting"
  if (READY_STATUSES.has(s)) {
    if (node?.ready === false && node?.quotaExhausted !== true) return "unavailable"
    if (node?.quotaExhausted === true || node?.exhausted === true) return "quota_exhausted"
    return "ready"
  }
  if (s.includes("exhaust") || s.includes("full") || s.includes("limit")) return "quota_exhausted"
  if (s.includes("offline") || s.includes("pause") || s.includes("login") || s.includes("error")) {
    return "unavailable"
  }
  return "ready"
}

/**
 * Convert camelCase / PascalCase / kebab-case / spaces into canonical snake_case.
 * e.g. `sevenDayFable` -> `seven_day_fable`, `fiveHourOpus` -> `five_hour_opus`,
 * `7dFable` -> `7d_fable`, `sevenDayOverageIncluded` -> `seven_day_overage_included`.
 */
export function toSnakeCase(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s./-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function looksLikeWindowObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
  const keys = [
    "utilization",
    "used",
    "usage",
    "usedRatio",
    "used_ratio",
    "utilizationRatio",
    "utilization_ratio",
    "usedPercent",
    "used_percent",
    "usedPercentage",
    "used_percentage",
    "utilizationPercent",
    "utilization_percent",
    "percent",
    "percentage",
    "pct",
    "remaining",
    "left",
    "remainingRatio",
    "remaining_ratio",
    "remainingPercent",
    "remaining_percent",
    "remainingPercentage",
    "remaining_percentage",
    "resetsAt",
    "resets_at",
    "resetAt",
    "reset_at",
    "resetSecs",
    "reset_secs",
    "amount",
    "limit",
    "spent",
  ]
  return keys.some((k) => k in obj)
}

function extractRawWindowEntries(node) {
  const entries = []
  const seen = new Set()

  const add = (key, obj, extraMeta = null) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return
    const merged = extraMeta ? { ...extraMeta, ...obj } : obj
    const sig = `${toSnakeCase(key)}::${merged.name ?? merged.label ?? merged.key ?? merged.window ?? ""}::${merged.model ?? merged.scope ?? ""}`
    if (seen.has(sig)) return
    seen.add(sig)
    entries.push({ key, raw: merged })
  }

  const addScopedContainer = (containerKey, val) => {
    if (!val || typeof val !== "object") return
    const normContainer = toSnakeCase(containerKey)
    const isWeeklyScoped = normContainer.includes("weekly") || normContainer.includes("7d") || normContainer.includes("seven_day")
    const isFiveHourScoped = normContainer.includes("5h") || normContainer.includes("five_hour")
    const prefix = isFiveHourScoped ? "five_hour" : isWeeklyScoped ? "seven_day" : "seven_day"

    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i]
        if (!item || typeof item !== "object") continue
        const scopeName = String(item.model ?? item.scope ?? item.name ?? item.label ?? item.key ?? `scoped_${i}`)
        add(`${prefix}_${toSnakeCase(scopeName)}`, item, {
          name: item.name ?? item.label ?? scopeName,
          scope: item.scope ?? item.model ?? scopeName,
        })
      }
      return
    }

    for (const [scopeName, item] of Object.entries(val)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      if (looksLikeWindowObject(item)) {
        add(`${prefix}_${toSnakeCase(scopeName)}`, item, {
          name: item.name ?? item.label ?? scopeName,
          scope: item.scope ?? item.model ?? scopeName,
        })
      }
    }
  }

  // Gather nested snapshot / quota / usage containers on the node
  const nestedRoots = [
    node,
    node.snapshot,
    node.quotaSnapshot,
    node.quota_snapshot,
    node.usageSnapshot,
    node.usage_snapshot,
    node.quota,
    node.quotas,
    node.usage,
    node.usages,
  ].filter((c) => c && typeof c === "object" && !Array.isArray(c))

  // Form 1: array of windows (`windows`, `limits`, `rateLimits`, `rate_limits`, `buckets`)
  for (const root of nestedRoots) {
    for (const arrKey of ["windows", "limits", "rateLimits", "rate_limits", "buckets", "pools"]) {
      const arr = root[arrKey]
      if (!Array.isArray(arr)) continue
      for (let i = 0; i < arr.length; i++) {
        const w = arr[i]
        if (!w || typeof w !== "object") continue
        const k = String(w.key ?? w.id ?? w.window ?? w.type ?? w.name ?? w.label ?? `window_${i}`)
        add(k, w)
      }
    }
  }

  // Form 2: object/map of named windows inside containers (including nested `weekly_scoped` / `modelWindows`!)
  const skipKeys = new Set([
    "windows",
    "limits",
    "rateLimits",
    "rate_limits",
    "buckets",
    "pools",
    "status",
    "state",
    "health",
    "updatedAt",
    "updated_at",
    "snapshotAt",
    "snapshot_at",
    "capturedAt",
    "captured_at",
    "fetchedAt",
    "fetched_at",
    "resets",
    "resetVouchers",
    "reset_vouchers",
    "vouchers",
    "extra_usage",
    "extraUsage",
    "summary",
    "plan",
    "tier",
    "endpoint",
    "models",
    "availableModels",
    "available_models",
    "snapshot",
    "quotaSnapshot",
    "quota_snapshot",
    "usageSnapshot",
    "usage_snapshot",
    "quota",
    "quotas",
    "usage",
    "usages",
  ])

  const scopedContainerKeys = new Set([
    "weekly_scoped",
    "weeklyScoped",
    "five_hour_scoped",
    "fiveHourScoped",
    "model_windows",
    "modelWindows",
    "model_limits",
    "modelLimits",
    "scoped",
    "scoped_windows",
    "scopedWindows",
    "by_model",
    "byModel",
  ])

  for (const root of nestedRoots) {
    // Check nested object maps (`windows`, `limits`, `rateLimits`, `rate_limits`, `buckets`, `pools`)
    const containers = [root]
    for (const mapKey of ["windows", "limits", "rateLimits", "rate_limits", "buckets", "pools"]) {
      if (root[mapKey] && typeof root[mapKey] === "object" && !Array.isArray(root[mapKey])) {
        containers.push(root[mapKey])
      }
    }

    for (const container of containers) {
      for (const [k, v] of Object.entries(container)) {
        if (scopedContainerKeys.has(k)) {
          addScopedContainer(k, v)
          continue
        }
        if (skipKeys.has(k)) continue
        if (!v || typeof v !== "object" || Array.isArray(v)) continue
        if (looksLikeWindowObject(v)) {
          add(k, v)
        }
      }
    }
  }

  // Form 3: flat scalar fields directly on node/snapshot (e.g. `fiveHourUtilization` + `fiveHourResetsAt`)
  for (const root of nestedRoots) {
    const flat5 = finiteNumber(
      root.fiveHourUtilization ?? root.five_hour_utilization ?? root.utilization5h ?? root.used5h ?? root.fiveHourUsed,
    )
    if (flat5 !== null) {
      add("five_hour", {
        utilization: flat5,
        resetsAt: root.fiveHourResetsAt ?? root.five_hour_resets_at ?? root.reset5h ?? root.resetsAt5h,
      })
    }
    const flat7 = finiteNumber(
      root.sevenDayUtilization ?? root.seven_day_utilization ?? root.utilization7d ?? root.used7d ?? root.sevenDayUsed,
    )
    if (flat7 !== null) {
      add("seven_day", {
        utilization: flat7,
        resetsAt: root.sevenDayResetsAt ?? root.seven_day_resets_at ?? root.reset7d ?? root.resetsAt7d,
      })
    }
    const flatFable = finiteNumber(
      root.fableUtilization ?? root.fable_utilization ?? root.sevenDayFableUtilization ?? root.seven_day_fable_utilization,
    )
    if (flatFable !== null) {
      add("seven_day_fable", {
        utilization: flatFable,
        resetsAt: root.fableResetsAt ?? root.fable_resets_at ?? root.sevenDayFableResetsAt ?? root.seven_day_fable_resets_at,
      })
    }
  }

  return entries
}

function readWindowReading(w) {
  // Explicit ratio fields (0..1 -> multiply by 100)
  for (const k of ["usedRatio", "used_ratio", "utilizationRatio", "utilization_ratio", "ratio"]) {
    const n = finiteNumber(w[k])
    if (n !== null) return { value: n * 100, explicitScale: "ratio", ambiguous: false }
  }
  for (const k of ["remainingRatio", "remaining_ratio", "leftRatio", "left_ratio"]) {
    const n = finiteNumber(w[k])
    if (n !== null) return { value: (1 - n) * 100, explicitScale: "ratio", ambiguous: false }
  }

  // Explicit percent fields (0..100)
  for (const k of [
    "usedPercent",
    "used_percent",
    "usedPercentage",
    "used_percentage",
    "utilizationPercent",
    "utilization_percent",
    "utilizationPct",
    "utilization_pct",
    "percent",
    "percentage",
    "pct",
  ]) {
    const n = finiteNumber(w[k])
    if (n !== null) return { value: n, explicitScale: "percent", ambiguous: false }
  }
  for (const k of [
    "remainingPercent",
    "remaining_percent",
    "remainingPercentage",
    "remaining_percentage",
    "leftPercent",
    "left_percent",
  ]) {
    const n = finiteNumber(w[k])
    if (n !== null) return { value: 100 - n, explicitScale: "percent", ambiguous: false }
  }

  // Amount / limit counts (e.g. Ollama monthly $36 / $60 or credit windows)
  const amount = finiteNumber(w.amount ?? w.usedAmount ?? w.used_amount ?? w.spent)
  const limit = positiveNumber(w.limit ?? w.total ?? w.cap ?? w.max)
  if (amount !== null && limit !== null) {
    return {
      value: (amount / limit) * 100,
      explicitScale: "amount",
      ambiguous: false,
      amount,
      limit,
    }
  }

  // Ambiguous fields (`utilization`, `used`) whose scale might be 0..1 or 0..100
  for (const k of ["utilization", "used", "usage"]) {
    const n = finiteNumber(w[k])
    if (n !== null) {
      const rem = finiteNumber(w.remaining ?? w.left)
      return { value: n, remaining: rem, explicitScale: null, ambiguous: true }
    }
  }

  // Bare `remaining` without `used`
  const rem = finiteNumber(w.remaining ?? w.left)
  if (rem !== null) {
    return { value: rem, isRemainingOnly: true, explicitScale: null, ambiguous: true }
  }

  return { value: null, explicitScale: null, ambiguous: false }
}

/**
 * Determine whether ambiguous `utilization` / `used` numbers in a payload
 * are on a `0..1` ratio scale or a `0..100` percentage scale.
 */
export function detectUtilizationScale(rawPayload, rawNodeWindows, configuredScale = "auto") {
  if (configuredScale === "ratio" || configuredScale === "percent") {
    return configuredScale
  }

  const samples = []
  let hasExhaustedAtOne = false
  let hasSumNearOne = false
  let hasSumNearHundred = false

  const summaryMax = finiteNumber(
    rawPayload?.summary?.maxUtilization ??
      rawPayload?.summary?.max_utilization ??
      rawPayload?.maxUtilization,
  )
  if (summaryMax !== null) samples.push(summaryMax)

  for (const { nodeStatus, reading } of rawNodeWindows) {
    if (!reading.ambiguous || reading.value === null) continue
    samples.push(reading.value)
    if (reading.remaining !== undefined && reading.remaining !== null) {
      const sum = reading.value + reading.remaining
      if (Math.abs(sum - 1) <= 0.05) hasSumNearOne = true
      if (Math.abs(sum - 100) <= 1.5) hasSumNearHundred = true
    }
    if (nodeStatus === "quota_exhausted" && reading.value === 1) {
      hasExhaustedAtOne = true
    }
  }

  if (samples.some((v) => v > 1.0001)) return "percent"
  if (hasSumNearHundred && !hasSumNearOne) return "percent"
  if (hasSumNearOne && !hasSumNearHundred) return "ratio"
  if (hasExhaustedAtOne) return "ratio"
  if (samples.some((v) => v > 0 && v < 1)) return "ratio"
  return "percent"
}

function normalizeModelScopeToken(raw) {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return ""
  if (s === "overage_included" || s === "overage-included" || s === "overage included") {
    return "fable"
  }
  // Matches Magpie's `claudeScopeModel`: "Fable 5.1" -> "fable-5-1", "Fable" -> "fable"
  return s.replace(/[\s._]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
}

function formatScopeLabel(modelScope, fallbackName = "") {
  if (fallbackName && /fable|mythos|opus|sonnet|haiku|codex|flash|pro/i.test(fallbackName)) {
    const cleaned = fallbackName
      .replace(/^(?:7\s*days?|5\s*hours?|7d|5h|weekly|current\s*week|current\s*session)\s*[·:\-–—/|]*\s*/i, "")
      .replace(/^\((.+)\)$/, "$1")
      .trim()
    if (cleaned) return cleaned
  }
  if (!modelScope) return ""
  return modelScope
    .split("-")
    .map((part, i) => (i === 0 ? capitalize(part) : part))
    .join(" ")
    .replace(/(\d+)\s+(\d+)/g, "$1.$2")
}

function classifyWindow(key, raw) {
  const normKey = toSnakeCase(key)
  const rawName = String(raw.name ?? raw.label ?? "").trim()
  const normName = rawName.toLowerCase()
  const spanRaw = positiveNumber(
    raw.span ?? raw.spanSecs ?? raw.span_secs ?? raw.windowSeconds ?? raw.window_seconds ?? raw.durationSecs ?? raw.duration_secs,
  )

  let model = typeof raw.model === "string" ? normalizeModelScopeToken(raw.model) : ""
  if (
    !model &&
    typeof raw.scope === "string" &&
    !["all", "global", "account", "default", "primary", "secondary"].includes(raw.scope.trim().toLowerCase())
  ) {
    model = normalizeModelScopeToken(raw.scope)
  }

  const models = Array.isArray(raw.models)
    ? raw.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
    : []

  // 1. Detect model scope embedded in snake_case key (e.g. seven_day_fable, seven_day_overage_included,
  //    seven_day_fable_5_1, seven_day_opus, seven_day_sonnet, seven_day_mythos, fable_7d, 5h_fable, fable)
  if (!model) {
    const keyPatterns = [
      /(?:^|_)(?:seven_day|7d|weekly|week|five_hour|5h|session)_((?:overage_included)|(?:opus|sonnet|haiku|fable|mythos|codex|flash|pro)(?:_[0-9]+(?:_[0-9]+)?)?)$/,
      /^((?:overage_included)|(?:opus|sonnet|haiku|fable|mythos)(?:_[0-9]+(?:_[0-9]+)?)?)(?:_(?:seven_day|7d|weekly|week|five_hour|5h))?$/,
    ]
    for (const re of keyPatterns) {
      const m = normKey.match(re)
      if (m) {
        model = normalizeModelScopeToken(m[1])
        break
      }
    }
  }

  // 2. Detect model scope in display name/label (e.g. "7 days · Fable", "Current week (Fable 5.1)", "Fable 每周")
  if (!model && normName) {
    const nameMatch = normName.match(
      /\b(overage[_ ]included|(?:fable|mythos|opus|sonnet|haiku)(?:[\s-]+\d+(?:[.-]\d+)?)?)\b/i,
    )
    if (nameMatch) {
      model = normalizeModelScopeToken(nameMatch[1])
    }
  }

  const isFiveHour =
    normKey === "five_hour" ||
    normKey === "5h" ||
    normKey === "5_hour" ||
    normKey === "limit_5h" ||
    normKey === "rolling_5h" ||
    normKey === "session" ||
    normKey === "primary" ||
    normKey.startsWith("five_hour_") ||
    normKey.startsWith("5h_") ||
    normKey.endsWith("_5h") ||
    normKey.endsWith("_five_hour") ||
    normName === "5 hours" ||
    normName === "5h" ||
    normName.includes("5 hour") ||
    normName.includes("5小时") ||
    normName.includes("current session") ||
    (spanRaw !== null && spanRaw >= 4.5 * 3600 && spanRaw <= 5.5 * 3600)

  const isSevenDay =
    normKey === "seven_day" ||
    normKey === "7d" ||
    normKey === "7_day" ||
    normKey === "limit_7d" ||
    normKey === "weekly" ||
    normKey === "week" ||
    normKey === "secondary" ||
    normKey.startsWith("seven_day_") ||
    normKey.startsWith("7d_") ||
    normKey.startsWith("weekly_") ||
    normKey.endsWith("_7d") ||
    normKey.endsWith("_seven_day") ||
    normKey.endsWith("_weekly") ||
    normKey === "overage_included" ||
    normName === "7 days" ||
    normName === "7d" ||
    normName === "weekly" ||
    normName.includes("7 day") ||
    normName.includes("7天") ||
    normName.includes("每周") ||
    normName.includes("current week") ||
    (spanRaw !== null && spanRaw >= 6.5 * 86400 && spanRaw <= 7.5 * 86400) ||
    // Bare Claude model-family windows (e.g. `fable`, `mythos`, `opus`, `sonnet`) default to weekly in Anthropic
    (!isFiveHour && /^(?:fable|mythos|opus|sonnet|haiku)(?:-|$)/.test(model))

  const isMonthly =
    normKey === "monthly" ||
    normKey === "month" ||
    normKey === "30d" ||
    normName.includes("month") ||
    normName.includes("本月") ||
    (spanRaw !== null && spanRaw >= 27 * 86400 && spanRaw <= 32 * 86400)

  const isCursorPool =
    normKey === "auto" || normKey === "api" || normName === "auto" || normName === "api"

  const scopeLabel = formatScopeLabel(model, rawName)

  if (isFiveHour) {
    return {
      kind: model || models.length ? "model_five_hour" : "five_hour",
      span: spanRaw ?? FIVE_HOUR_SECS,
      model,
      models,
      defaultName: model ? `5 hours · ${scopeLabel}` : "5 hours",
    }
  }
  if (isSevenDay) {
    return {
      kind: model || models.length ? "model_seven_day" : "seven_day",
      span: spanRaw ?? SEVEN_DAY_SECS,
      model,
      models,
      defaultName: model ? `7 days · ${scopeLabel}` : "7 days",
    }
  }
  if (isMonthly) {
    return {
      kind: "monthly",
      span: spanRaw ?? 30 * 86400,
      model,
      models,
      defaultName: "Month",
    }
  }
  if (isCursorPool) {
    return {
      kind: "pool",
      span: spanRaw ?? 0,
      model,
      models,
      defaultName: rawName || capitalize(normKey),
    }
  }
  return {
    kind: "other",
    span: spanRaw ?? 0,
    model,
    models,
    defaultName: rawName || key,
  }
}

function capitalize(s) {
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function parseResetsVouchers(raw) {
  const r = raw?.resets ?? raw?.resetVouchers ?? raw?.reset_vouchers ?? raw?.vouchers
  if (!r || typeof r !== "object") return null
  const count = nonNegativeInt(r.count ?? r.available ?? r.total) ?? 0
  const fiveHour = nonNegativeInt(r.fiveHour ?? r.five_hour) ?? 0
  const weekly = nonNegativeInt(r.weekly ?? r.seven_day) ?? 0
  const each = Array.isArray(r.each)
    ? r.each
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          until: parseTimestampMs(e.until ?? e.expiresAt ?? e.expires_at),
          window:
            e.window === "fiveHour" || e.window === "five_hour"
              ? "fiveHour"
              : e.window === "weekly" || e.window === "seven_day"
                ? "weekly"
                : "",
        }))
    : []
  const totalCount = count || fiveHour + weekly || each.length
  if (totalCount <= 0) return null
  return {
    count: totalCount,
    fiveHour,
    weekly,
    byWindow: Boolean(r.byWindow ?? r.by_window ?? (fiveHour > 0 || weekly > 0)),
    team: Boolean(r.team),
    until: parseTimestampMs(r.until ?? r.expiresAt ?? r.expires_at),
    each,
  }
}

function resolveNodeWeight(node, accountType, plan, isGroup, totalCount, readyCount, options) {
  const nodeWeights = options?.nodeWeights ?? {}
  const idKeys = [node.id, node.nodeId, node.accountId, node.name, node.label].filter(
    (x) => typeof x === "string" && x.trim(),
  )
  for (const k of idKeys) {
    const userW = positiveNumber(nodeWeights[k])
    if (userW !== null) return { weight: userW, weightSource: "user" }
  }

  const apiW = positiveNumber(
    node.weight ?? node.capacityWeight ?? node.capacity_weight ?? node.quotaWeight ?? node.quota_weight,
  )
  if (apiW !== null) return { weight: apiW, weightSource: "api" }

  const tierW = inferTierWeight(accountType, plan, options?.tierWeights)
  const groupFactor = isGroup ? Math.max(1, totalCount ?? readyCount ?? 1) : 1
  if (tierW !== null) {
    return {
      weight: tierW * groupFactor,
      weightSource: isGroup && groupFactor > 1 ? "group_count" : "tier",
    }
  }

  if (isGroup && groupFactor > 1) {
    return { weight: groupFactor, weightSource: "group_count" }
  }

  return { weight: 1, weightSource: "default" }
}

function collectRawNodes(raw) {
  let base = []
  if (Array.isArray(raw.nodes)) base = [...raw.nodes]
  else if (Array.isArray(raw.accounts)) base = [...raw.accounts]
  else if (Array.isArray(raw.items)) base = [...raw.items]
  else if (Array.isArray(raw.data)) base = [...raw.data]
  else if (Array.isArray(raw.data?.nodes)) base = [...raw.data.nodes]
  else if (Array.isArray(raw.data?.accounts)) base = [...raw.data.accounts]
  else if (Array.isArray(raw.usage?.nodes)) base = [...raw.usage.nodes]
  else if (Array.isArray(raw.result?.nodes)) base = [...raw.result.nodes]
  else if (Array.isArray(raw.endpoint?.nodes)) base = [...raw.endpoint.nodes]

  if (Array.isArray(raw.groups) && raw.groups.length > 0) {
    for (const g of raw.groups) {
      if (g && typeof g === "object") {
        base.push({ isGroup: true, ...g })
      }
    }
  }

  // If a group node embeds its individual `members` / `accounts` / `nodes`,
  // unpack them so each upstream account can be tracked & displayed individually.
  const expanded = []
  for (const item of base) {
    if (!item || typeof item !== "object") continue
    const nested = Array.isArray(item.members)
      ? item.members
      : Array.isArray(item.accounts)
        ? item.accounts
        : Array.isArray(item.nodes)
          ? item.nodes
          : null
    const memberObjs = nested
      ? nested.filter((m) => m && typeof m === "object" && !Array.isArray(m))
      : []
    if (memberObjs.length > 0) {
      const parentType =
        item.accountType ??
        item.account_type ??
        item.providerType ??
        item.provider_type ??
        item.type ??
        item.provider ??
        ""
      const parentGroupName = String(item.name ?? item.label ?? item.title ?? "").trim()
      for (const m of memberObjs) {
        expanded.push({
          ...(parentType ? { accountType: parentType } : {}),
          ...(parentGroupName ? { groupName: parentGroupName } : {}),
          ...m,
        })
      }
      continue
    }
    expanded.push(item)
  }

  return expanded
}

/**
 * Normalize raw CC Host `GET /v1/usage` JSON payload into canonical internal model.
 */
export function parseCchostUsage(payload, { now = Date.now(), utilizationScale = "auto", nodeWeights = {}, tierWeights = {} } = {}) {
  const raw = payload && typeof payload === "object" ? payload : {}
  const rawNodes = collectRawNodes(raw)

  // First pass: extract raw windows & readings across all nodes to infer scale cleanly.
  const stagedNodes = rawNodes
    .filter((n) => n && typeof n === "object")
    .map((n, idx) => {
      const status = normalizeStatus(n.status ?? n.state ?? n.health, n)
      const rawEntries = extractRawWindowEntries(n).map(({ key, raw: w }) => ({
        key,
        raw: w,
        reading: readWindowReading(w),
      }))
      return { idx, raw: n, status, rawEntries }
    })

  const allWindowReadings = stagedNodes.flatMap((sn) =>
    sn.rawEntries.map((e) => ({ nodeStatus: sn.status, reading: e.reading })),
  )
  const scale = detectUtilizationScale(raw, allWindowReadings, utilizationScale)

  const scaleValue = (reading) => {
    if (reading.value === null) return null
    if (!reading.ambiguous) return Math.max(0, reading.value)
    const mult = scale === "ratio" ? 100 : 1
    if (reading.isRemainingOnly) {
      return Math.max(0, 100 - reading.value * mult)
    }
    return Math.max(0, reading.value * mult)
  }

  const summaryRaw = finiteNumber(
    raw.summary?.maxUtilization ??
      raw.summary?.max_utilization ??
      raw.maxUtilization,
  )
  let summaryMaxUtilization = null
  if (summaryRaw !== null) {
    // Handle case where summary.maxUtilization uses 0..1 while windows use 0..100 or vice versa
    const summaryIsRatio =
      utilizationScale === "ratio" ||
      (utilizationScale === "auto" &&
        summaryRaw > 0 &&
        summaryRaw < 1 &&
        scale === "ratio")
    summaryMaxUtilization = Math.max(0, summaryRaw * (summaryIsRatio ? 100 : 1))
  }

  const nodes = stagedNodes.map(({ idx, raw: n, status, rawEntries }) => {
    const accountObj = n.account && typeof n.account === "object" ? n.account : null
    const accountType = normalizeAccountType(
      n.accountType ??
        n.account_type ??
        n.providerType ??
        n.provider_type ??
        n.type ??
        n.provider ??
        n.platform ??
        n.service ??
        n.vendor ??
        accountObj?.accountType ??
        accountObj?.type ??
        accountObj?.provider ??
        "",
    )
    const isPayg = accountType === "aistudio" || accountType === "openai"
    const isGroup = Boolean(
      n.isGroup ??
        n.is_group ??
        n.sharedGroup ??
        n.shared_group ??
        (n.kind === "group" || n.nodeType === "group" || n.node_type === "group"),
    )
    const readyCount = nonNegativeInt(
      n.readyCount ?? n.ready_count ?? n.activeCount ?? n.active_count,
    )
    const totalCount = nonNegativeInt(
      n.totalCount ?? n.total_count ?? n.memberCount ?? n.member_count ?? n.size,
    )
    const plan = String(
      n.plan ??
        n.planType ??
        n.plan_type ??
        n.tier ??
        n.accountTier ??
        n.account_tier ??
        n.subscriptionTier ??
        n.subscription_tier ??
        n.subscriptionType ??
        n.subscription_type ??
        accountObj?.plan ??
        accountObj?.tier ??
        (typeof n.subscription === "string" ? n.subscription : "") ??
        "",
    ).trim()
    const id = String(
      n.id ??
        n.nodeId ??
        n.node_id ??
        n.accountId ??
        n.account_id ??
        accountObj?.id ??
        `node-${idx + 1}`,
    )
    const name = String(
      n.name ??
        n.nodeName ??
        n.node_name ??
        n.accountName ??
        n.account_name ??
        n.label ??
        n.displayName ??
        n.display_name ??
        n.title ??
        n.slug ??
        accountObj?.name ??
        accountObj?.label ??
        accountObj?.email ??
        n.email ??
        id,
    ).trim()
    const models = Array.isArray(n.models ?? n.availableModels ?? n.available_models)
      ? (n.models ?? n.availableModels ?? n.available_models)
          .filter((m) => typeof m === "string" && m.trim())
          .map((m) => m.trim())
      : []
    const snapshotAt = parseTimestampMs(
      n.snapshotAt ?? n.snapshot_at ?? n.capturedAt ?? n.captured_at ?? n.updatedAt ?? n.updated_at ?? n.fetchedAt ?? n.fetched_at,
    )

    const { weight, weightSource } = resolveNodeWeight(
      n,
      accountType,
      plan,
      isGroup,
      totalCount,
      readyCount,
      { nodeWeights, tierWeights },
    )

    const windows = rawEntries.map(({ key, raw: w, reading }) => {
      const cls = classifyWindow(key, w)
      const rawUsed = scaleValue(reading)
      const resetSecs = positiveNumber(w.resetSecs ?? w.reset_secs ?? w.resetIn ?? w.reset_in)
      const parsedReset = parseTimestampMs(
        w.resetsAt ?? w.resets_at ?? w.resetAt ?? w.reset_at ?? w.resets,
      )
      const resetsAt =
        parsedReset ??
        (resetSecs !== null ? (snapshotAt ?? now) + Math.round(resetSecs * 1000) : null)

      const expired = resetsAt !== null && resetsAt <= now
      const used = rawUsed === null ? null : expired ? 0 : rawUsed
      const effectiveResetsAt = expired ? null : resetsAt

      return {
        kind: cls.kind,
        key,
        name: String(w.name ?? w.label ?? cls.defaultName).trim() || cls.defaultName,
        used,
        rawUsed,
        expired,
        resetsAt: effectiveResetsAt,
        span: cls.span,
        model: cls.model,
        models: cls.models,
        amount: reading.amount ?? finiteNumber(w.amount),
        limit: reading.limit ?? positiveNumber(w.limit),
        unit: typeof w.unit === "string" ? w.unit.trim() : "",
        display: typeof w.display === "string" ? w.display.trim() : "",
      }
    })

    // If a shared group reports 0 ready out of N total, mark it exhausted unless explicitly unavailable.
    let effectiveStatus = status
    if (isGroup && readyCount !== null && totalCount !== null && totalCount > 0 && readyCount === 0 && effectiveStatus === "ready") {
      effectiveStatus = "quota_exhausted"
    }

    // If node is marked quota_exhausted but every known window has expired past reset, it is recovering/ready.
    if (
      effectiveStatus === "quota_exhausted" &&
      windows.length > 0 &&
      windows.every((w) => w.expired || (w.used !== null && w.used < 100))
    ) {
      effectiveStatus = "ready"
    }

    const hasQuotaWindows = windows.some((w) => w.used !== null)

    return {
      id,
      name,
      accountType,
      plan,
      status: effectiveStatus,
      rawStatus: String(n.status ?? n.state ?? ""),
      isGroup,
      readyCount,
      totalCount,
      weight,
      weightSource,
      models,
      snapshotAt,
      hasQuotaWindows,
      isPayg,
      windows,
      resets: parseResetsVouchers(n),
    }
  })

  const endpointName = String(
    raw.endpoint?.name ?? raw.endpointName ?? raw.endpoint_name ?? "",
  ).trim()
  const routingStrategy = String(
    raw.endpoint?.routingStrategy ??
      raw.endpoint?.routing_strategy ??
      raw.routingStrategy ??
      raw.routing_strategy ??
      "",
  ).trim().toLowerCase()

  const snapshotAt =
    parseTimestampMs(
      raw.snapshotAt ?? raw.snapshot_at ?? raw.updatedAt ?? raw.updated_at ?? raw.timestamp,
    ) ??
    nodes.reduce((best, n) => (n.snapshotAt && (!best || n.snapshotAt > best) ? n.snapshotAt : best), null)

  return {
    endpointName,
    routingStrategy,
    scale,
    summaryMaxUtilization,
    snapshotAt,
    nodes,
  }
}
