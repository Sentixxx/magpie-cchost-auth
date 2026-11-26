import {
  ACCOUNT_TYPE_LABELS,
  FIVE_HOUR_SECS,
  SEVEN_DAY_SECS,
} from "./config.mjs"

function round1(n) {
  return Math.round(n * 10) / 10
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function minPositive(list) {
  let best = null
  for (const v of list) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      if (best === null || v < best) best = v
    }
  }
  return best
}

function maxPositive(list) {
  let best = null
  for (const v of list) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      if (best === null || v > best) best = v
    }
  }
  return best
}

/**
 * Infer which CC Host account types can serve a given model ID when the node
 * does not explicitly list its `models` array.
 */
export function inferModelAccountTypes(modelId, presentTypes) {
  const id = String(modelId ?? "").trim().toLowerCase()
  if (!id) return []

  // Explicit account-type prefix (cchost.ai/docs/api#指定账号类型)
  const prefixMatch = id.match(/^(claude|codex|gemini|grok|kimi|cursor|ollama|aistudio|openai)\//)
  if (prefixMatch) {
    return presentTypes.has(prefixMatch[1]) ? [prefixMatch[1]] : []
  }

  // Note: aistudio and openai accounts NEVER serve unprefixed model IDs in CC Host.
  const subTypes = [...presentTypes].filter((t) => t !== "aistudio" && t !== "openai")

  const matches = []
  if (
    id.startsWith("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku") ||
    id.includes("fable") ||
    id.includes("mythos")
  ) {
    // Claude, Gemini (Antigravity), and Cursor accounts can serve Claude models on CC Host
    for (const t of ["claude", "gemini", "cursor"]) {
      if (presentTypes.has(t)) matches.push(t)
    }
    return matches
  }
  if (id.startsWith("gpt-") || id.startsWith("codex") || /^o[134](-|$)/.test(id)) {
    for (const t of ["codex", "cursor"]) {
      if (presentTypes.has(t)) matches.push(t)
    }
    return matches
  }
  if (id.startsWith("gemini")) {
    for (const t of ["gemini", "cursor"]) {
      if (presentTypes.has(t)) matches.push(t)
    }
    return matches
  }
  if (id.startsWith("grok")) {
    if (presentTypes.has("grok")) matches.push("grok")
    return matches
  }
  if (id.startsWith("kimi") || id.startsWith("moonshot")) {
    if (presentTypes.has("kimi")) matches.push("kimi")
    return matches
  }
  if (id.includes(":")) {
    // Ollama formal names like gpt-oss:120b, qwen3:32b
    if (presentTypes.has("ollama")) matches.push("ollama")
    return matches
  }

  return subTypes
}

function buildModelPoolRoutingMap(activeNodes, catalogModelIds) {
  const presentTypes = new Set(activeNodes.map((n) => n.accountType))
  const explicitByModel = new Map()

  for (const node of activeNodes) {
    for (const m of node.models) {
      let set = explicitByModel.get(m)
      if (!set) {
        set = new Set()
        explicitByModel.set(m, set)
      }
      set.add(node.accountType)
    }
  }

  const allModels = new Set([...(catalogModelIds ?? []), ...explicitByModel.keys()])
  // Map: poolSignature ("claude" or "claude+gemini") -> { types: string[], models: string[] }
  const groups = new Map()

  for (const modelId of allModels) {
    let types
    if (explicitByModel.has(modelId)) {
      types = [...explicitByModel.get(modelId)]
    } else {
      types = inferModelAccountTypes(modelId, presentTypes)
    }
    types = types.filter((t) => t !== "aistudio" && t !== "openai").sort()
    if (types.length === 0) continue
    const sig = types.join("+")
    let g = groups.get(sig)
    if (!g) {
      g = { types, models: [] }
      groups.set(sig, g)
    }
    g.models.push(modelId)
  }

  return groups
}

const FIVE_HOUR_SEVEN_DAY_TYPES = new Set([
  "claude",
  "codex",
  "gemini",
  "grok",
  "kimi",
])

/**
 * Compute per-node effective 5h and 7d window states, applying cross-window
 * bottleneck coupling:
 *
 * - If a 5h+7d vendor node reports `seven_day` with no `five_hour` (idle > 5h,
 *   unstarted session window), its unstarted 5h utilization is 0% (unless
 *   blocked by 7d). Nodes with neither window remain unknown (collecting).
 * - If a node's 7d window is >= 100% (or node status is `quota_exhausted`),
 *   its remaining 5h quota is stranded (unusable), so its effective 5h used
 *   becomes 100%, and its effective unblock time is max(blocking resets).
 * - If a node's 5h window is >= 100% and its 5h reset is >= its 7d reset,
 *   its remaining 7d quota is unreachable before weekly reset, so effective 7d
 *   becomes 100%.
 */
export function evaluateNodeEffectiveState(node, { now, crossWindowCoupling = true } = {}) {
  const w5 = node.windows.find((w) => w.kind === "five_hour") ?? null
  const w7 = node.windows.find((w) => w.kind === "seven_day") ?? null
  const modelWindows = node.windows.filter(
    (w) => w.kind === "model_seven_day" || w.kind === "model_five_hour",
  )

  const raw7 = w7?.used ?? null
  let raw5 = w5?.used ?? null
  if (raw5 === null && raw7 !== null && FIVE_HOUR_SEVEN_DAY_TYPES.has(node.accountType)) {
    // Idle 5h+7d account whose 5-hour session window has not started yet
    raw5 = 0
  }
  const r5 = w5?.resetsAt && w5.resetsAt > now ? w5.resetsAt : null
  const r7 = w7?.resetsAt && w7.resetsAt > now ? w7.resetsAt : null

  const statusExhausted = node.status === "quota_exhausted"
  const full5 = raw5 !== null && raw5 >= 100
  const full7 = raw7 !== null && raw7 >= 100

  let eff5 = raw5
  let eff7 = raw7
  let blocked5By7 = false
  let blocked7By5 = false

  if (crossWindowCoupling) {
    if (full7 || (statusExhausted && raw5 === null)) {
      eff5 = 100
      blocked5By7 = full7 && !full5
    } else if (statusExhausted && raw5 !== null && raw5 < 100 && !full7) {
      eff5 = 100
    }

    if (full5 && r5 !== null && r7 !== null && r5 >= r7 && raw7 !== null && raw7 < 100) {
      eff7 = 100
      blocked7By5 = true
    } else if (statusExhausted && raw7 === null && raw5 === null) {
      eff7 = 100
    }
  } else if (statusExhausted && raw5 === null && raw7 === null) {
    eff5 = 100
  }

  // Exact moment this node becomes unblocked for 5h requests when blocked.
  let unblockAt5 = r5
  if (eff5 !== null && eff5 >= 100) {
    const blockers = []
    if (full5 && r5 !== null) blockers.push(r5)
    if (full7 && r7 !== null) blockers.push(r7)
    unblockAt5 = maxPositive(blockers) ?? r5 ?? r7
  }

  const usable =
    node.status !== "unavailable" &&
    !statusExhausted &&
    (eff5 === null || eff5 < 100) &&
    (eff7 === null || eff7 < 100)

  return {
    node,
    usable,
    weight: node.weight,
    raw5,
    raw7,
    eff5,
    eff7,
    resetsAt5: r5,
    resetsAt7: r7,
    unblockAt5,
    blocked5By7,
    blocked7By5,
    has5: eff5 !== null,
    has7: eff7 !== null,
    modelWindows,
  }
}

/**
 * Aggregate a single window dimension (`five_hour` or `seven_day`) across a pool
 * of evaluated node states.
 */
export function aggregateWindowDimension(states, dimension, { mode = "weighted" } = {}) {
  const is5h = dimension === "five_hour"
  const known = states.filter((s) => (is5h ? s.has5 : s.has7))
  const collectingStates = states.filter((s) => !(is5h ? s.has5 : s.has7))
  const collectingCount = collectingStates.length
  const readyCollectingCount = collectingStates.filter(
    (s) => s.node.status === "ready" || s.node.status === "collecting",
  ).length

  if (known.length === 0) {
    return {
      known: false,
      used: null,
      resetsAt: null,
      collectingCount,
      totalWeight: states.reduce((acc, s) => acc + s.weight, 0),
    }
  }

  const values = known.map((s) => ({
    s,
    u: is5h ? s.eff5 : s.eff7,
    w: s.weight,
  }))
  const totalWeight = values.reduce((acc, x) => acc + x.w, 0)
  const anyKnownHasRoom = values.some((x) => x.u < 100)
  const anyHasRoom = anyKnownHasRoom || readyCollectingCount > 0
  const allFull = !anyKnownHasRoom

  let rawAgg
  switch (mode) {
    case "min_used": {
      rawAgg = Math.min(...values.map((x) => x.u))
      break
    }
    case "max_used": {
      rawAgg = Math.max(...values.map((x) => x.u))
      break
    }
    case "average": {
      if (allFull) {
        rawAgg = values.reduce((acc, x) => acc + x.u, 0) / values.length
      } else {
        rawAgg = values.reduce((acc, x) => acc + clamp(x.u, 0, 100), 0) / values.length
      }
      break
    }
    case "weighted":
    default: {
      if (allFull) {
        rawAgg = values.reduce((acc, x) => acc + x.u * x.w, 0) / totalWeight
      } else {
        // Cap individual overspent nodes at 100 when other nodes still have room so
        // one node at 105% never falsely erases another node's available headroom.
        rawAgg =
          values.reduce((acc, x) => acc + clamp(x.u, 0, 100) * x.w, 0) / totalWeight
      }
      break
    }
  }

  let used = round1(Math.max(0, rawAgg))
  // Guard against floating-point rounding to 100.0 when a node still has real headroom
  // (for non-conservative modes). Otherwise Magpie's Allowance.Full would bench a live pool.
  if (anyHasRoom && mode !== "max_used" && used >= 100) {
    used = 99.9
  }

  let resetsAt = null
  if (used >= 100) {
    // Pool is exhausted: earliest moment ANY blocked node recovers.
    const recoveryTimes = known
      .filter((s) => (is5h ? s.eff5 >= 100 : s.eff7 >= 100))
      .map((s) => (is5h ? s.unblockAt5 : s.resetsAt7))
    resetsAt = minPositive(recoveryTimes)
  } else if (is5h) {
    // Pool has headroom on 5h: earliest time utilization drops (matches CC Host UI).
    const activeTimes = known
      .filter((s) => s.eff5 > 0)
      .map((s) => (s.eff5 >= 100 ? s.unblockAt5 : s.resetsAt5))
    resetsAt =
      minPositive(activeTimes) ?? minPositive(known.map((s) => s.resetsAt5))
  } else {
    // Pool has headroom on 7d: earliest expiry among nodes with unspent weekly quota
    // (aligns directly with Magpie's Smart "use before expiry" routing).
    const expiringWithRoom = known
      .filter((s) => s.eff7 < 100)
      .map((s) => s.resetsAt7)
    resetsAt =
      minPositive(expiringWithRoom) ?? minPositive(known.map((s) => s.resetsAt7))
  }

  return {
    known: true,
    used,
    resetsAt,
    collectingCount,
    totalWeight,
    anyHasRoom,
  }
}

function isTierGatedModelScope(model) {
  return /^(?:fable|mythos)(?:-|$)/.test(model)
}

function nodeServesModelScope(node, modelScope) {
  if (!modelScope) return true
  if (Array.isArray(node.models) && node.models.length > 0) {
    const token = modelScope.toLowerCase()
    const dotted = token.replace(/-(\d+)-(\d+)/g, "-$1.$2")
    return node.models.some((m) => {
      const lm = m.toLowerCase()
      return lm.includes(token) || lm.includes(dotted)
    })
  }
  return true
}

function formatSubScopeLabel(modelScope, rawName = "") {
  if (rawName) {
    const cleaned = rawName
      .replace(/^(?:7\s*days?|5\s*hours?|7d|5h|weekly|current\s*week|current\s*session)\s*[·:\-–—/|]*\s*/i, "")
      .replace(/^\((.+)\)$/, "$1")
      .trim()
    if (cleaned) return cleaned
  }
  return modelScope
    .split("-")
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ")
    .replace(/(\d+)\s+(\d+)/g, "$1.$2")
}

function aggregateModelSubWindows(states, { mode, now, namePrefix = "" }) {
  // Discover distinct model-scoped sub-windows across nodes in this pool
  const subKeys = new Map()
  for (const s of states) {
    for (const mw of s.modelWindows) {
      if (!mw.model) continue
      const k = `${mw.kind}:${mw.model}`
      if (!subKeys.has(k)) {
        subKeys.set(k, {
          kind: mw.kind,
          model: mw.model,
          span: mw.span || (mw.kind === "model_five_hour" ? FIVE_HOUR_SECS : SEVEN_DAY_SECS),
          label: formatSubScopeLabel(mw.model, mw.name),
        })
      }
    }
  }

  const out = []
  for (const sub of subKeys.values()) {
    const is5h = sub.kind === "model_five_hour"
    const tierGated = isTierGatedModelScope(sub.model)

    // Filter eligible nodes:
    // - For tier-gated families (`fable`, `mythos`): only nodes that report this sub-window
    //   OR explicitly list a matching model in `node.models`, so a Claude Pro node without
    //   Fable access never dilutes a Max node's Fable utilization.
    // - For standard Claude sub-windows (`opus`, `sonnet`, `haiku`): all nodes in the pool
    //   whose `node.models` (if present) don't exclude the model; nodes without a separate
    //   Opus cap fall back to their general 7d/5h window.
    const eligible = states.filter((s) => {
      const hasOwn = s.modelWindows.some(
        (w) => w.kind === sub.kind && w.model === sub.model,
      )
      if (hasOwn) return true
      if (tierGated) {
        return Array.isArray(s.node.models) && s.node.models.length > 0 && nodeServesModelScope(s.node, sub.model)
      }
      return nodeServesModelScope(s.node, sub.model)
    })

    if (eligible.length === 0) continue

    const pseudoStates = eligible.map((s) => {
      const own = s.modelWindows.find(
        (w) => w.kind === sub.kind && w.model === sub.model,
      )
      const fallbackU = is5h ? s.eff5 : s.eff7
      const fallbackR = is5h ? s.resetsAt5 : s.resetsAt7
      let u = own?.used ?? fallbackU
      const r = own?.resetsAt && own.resetsAt > now ? own.resetsAt : fallbackR
      // Couple with node's general 7d/5h ceiling too
      if (u !== null && s.eff7 !== null && s.eff7 >= 100) u = 100
      if (is5h && u !== null && s.eff5 !== null && s.eff5 >= 100) u = 100
      return {
        ...s,
        has5: is5h && u !== null,
        has7: !is5h && u !== null,
        eff5: is5h ? u : s.eff5,
        eff7: !is5h ? u : s.eff7,
        resetsAt5: is5h ? r : s.resetsAt5,
        resetsAt7: !is5h ? r : s.resetsAt7,
        unblockAt5: is5h ? r : s.unblockAt5,
      }
    })

    const agg = aggregateWindowDimension(
      pseudoStates,
      is5h ? "five_hour" : "seven_day",
      { mode },
    )
    if (!agg.known) continue
    const baseName = `${is5h ? "5 hours" : "7 days"} · ${sub.label}`
    const display =
      eligible.length > 1
        ? formatPoolDisplay(pseudoStates, eligible.length, agg, mode)
        : ""
    out.push({
      name: namePrefix ? `${namePrefix} · ${baseName}` : baseName,
      used: agg.used,
      ...(agg.resetsAt ? { resetsAt: agg.resetsAt } : {}),
      span: sub.span,
      ...(display ? { display } : {}),
      model: sub.model,
    })
  }
  return out
}

function formatWeightBadge(totalWeight, states) {
  const hasNonDefault = states.some((s) => s.node.weightSource !== "default")
  if (!hasNonDefault) return ""
  const rounded = Number.isInteger(totalWeight)
    ? String(totalWeight)
    : totalWeight.toFixed(1).replace(/\.0$/, "")
  return `${rounded}x`
}

function formatPoolDisplay(states, allPoolNodesCount, agg, mode) {
  if (allPoolNodesCount <= 1 && states.length <= 1 && !states[0]?.node.isGroup) {
    return ""
  }

  // Sum ready/total counts respecting shared groups
  let readyUnits = 0
  let totalUnits = 0
  for (const s of states) {
    if (s.node.isGroup && s.node.totalCount !== null) {
      totalUnits += s.node.totalCount
      readyUnits += s.node.readyCount ?? (s.usable ? s.node.totalCount : 0)
    } else {
      totalUnits += 1
      if (s.usable) readyUnits += 1
    }
  }
  // Account for unavailable nodes in this pool that were filtered out of `states`
  const unavailableCount = Math.max(0, allPoolNodesCount - states.length)
  totalUnits += unavailableCount

  const parts = [`${readyUnits}/${totalUnits} ready`]
  const wBadge = formatWeightBadge(agg.totalWeight, states)
  if (wBadge) parts.push(wBadge)
  if (agg.collectingCount > 0) parts.push(`+${agg.collectingCount} collecting`)
  if (mode !== "weighted") parts.push(mode.replace("_", " "))
  return parts.join(" · ")
}

function aggregateResetsVouchers(nodes) {
  let count = 0
  let fiveHour = 0
  let weekly = 0
  let byWindow = false
  let team = false
  const each = []
  const untils = []

  for (const n of nodes) {
    if (!n.resets) continue
    count += n.resets.count
    fiveHour += n.resets.fiveHour
    weekly += n.resets.weekly
    byWindow = byWindow || n.resets.byWindow
    team = team || n.resets.team
    if (n.resets.until) untils.push(n.resets.until)
    for (const e of n.resets.each) {
      each.push({
        ...(e.until ? { until: e.until } : {}),
        ...(e.window ? { window: e.window } : {}),
      })
    }
  }

  if (count <= 0) return undefined
  const soonest = minPositive(untils)
  return {
    count,
    byWindow,
    fiveHour,
    weekly,
    team,
    ...(soonest ? { until: soonest } : {}),
    ...(each.length ? { each } : {}),
  }
}

function buildPlanSummary(activeSubNodes, unavailableCount, paygNodes) {
  if (activeSubNodes.length === 1 && !activeSubNodes[0].isGroup && unavailableCount === 0 && paygNodes.length === 0) {
    const n = activeSubNodes[0]
    const typeLabel = ACCOUNT_TYPE_LABELS[n.accountType] ?? n.accountType
    return n.plan ? `${typeLabel} ${n.plan}` : typeLabel
  }

  const byType = new Map()
  for (const n of activeSubNodes) {
    const cur = byType.get(n.accountType) ?? { count: 0, weight: 0, hasTierOrCustomWeight: false }
    cur.count += n.isGroup && n.totalCount ? n.totalCount : 1
    cur.weight += n.weight
    cur.hasTierOrCustomWeight =
      cur.hasTierOrCustomWeight ||
      n.weightSource === "tier" ||
      n.weightSource === "api" ||
      n.weightSource === "user"
    byType.set(n.accountType, cur)
  }

  const parts = []
  for (const [type, info] of byType.entries()) {
    const label = ACCOUNT_TYPE_LABELS[type] ?? type
    const mult = info.count > 1 ? ` ×${info.count}` : ""
    const w =
      info.hasTierOrCustomWeight && info.count > 1 && Math.abs(info.weight - info.count) > 0.01
        ? ` (${Number.isInteger(info.weight) ? info.weight : info.weight.toFixed(1)}x)`
        : ""
    parts.push(`${label}${mult}${w}`)
  }

  if (paygNodes.length > 0) {
    parts.push(`API Key ×${paygNodes.length}`)
  }
  if (unavailableCount > 0) {
    parts.push(`${unavailableCount} offline`)
  }
  return parts.join(" + ")
}

function formatNodeTitle(node) {
  const base = node.name || node.id
  const parts = []
  if (node.plan) parts.push(node.plan)
  else if (node.accountType && node.accountType !== "unknown") {
    parts.push(ACCOUNT_TYPE_LABELS[node.accountType] ?? node.accountType)
  }
  if (node.isGroup && node.totalCount !== null) {
    parts.push(`${node.readyCount ?? 0}/${node.totalCount} ready`)
  }
  return parts.length > 0 ? `${base} (${parts.join(", ")})` : base
}

/**
 * Emit real per-account progress-bar windows (`aside: true`) for every upstream
 * subscription in an aggregated CC Host endpoint:
 * - Each active node gets its own 5h, 7d, and model sub-window (Fable, Opus, Sonnet...)
 *   bars with real `used` %, `resetsAt`, and `span`.
 * - Intentionally omits `display` on numeric bars so Magpie's `quotaOfPlugin`
 *   never converts a `0%` `aside: true` bar into plain text (`w.Text`).
 * - Routing (`allowanceOf`) ignores `aside: true` windows, so per-account bars
 *   never break Magpie failover while giving full per-subscription visibility.
 */
function buildExpandedNodeWindows(states, unavailableNodes, now) {
  const rows = []

  for (const s of states) {
    const node = s.node
    const prefix = formatNodeTitle(node)
    let addedForNode = 0

    // Show each node's actual telemetry (raw5 / raw7) so the user sees each
    // subscription's real 5h, 7d, and Fable/Opus/Sonnet bars independently.
    const w5 = node.windows.find((w) => w.kind === "five_hour")
    const w7 = node.windows.find((w) => w.kind === "seven_day")

    if (w5 && w5.used !== null) {
      rows.push({
        name: `${prefix} · 5 hours`,
        used: round1(w5.used),
        ...(w5.resetsAt && w5.resetsAt > now ? { resetsAt: w5.resetsAt } : {}),
        span: w5.span || FIVE_HOUR_SECS,
        aside: true,
      })
      addedForNode++
    } else if (s.raw5 !== null) {
      // Idle 5h+7d account whose 5h window hasn't started yet
      rows.push({
        name: `${prefix} · 5 hours`,
        used: round1(s.raw5),
        span: FIVE_HOUR_SECS,
        aside: true,
      })
      addedForNode++
    }

    if (w7 && w7.used !== null) {
      rows.push({
        name: `${prefix} · 7 days`,
        used: round1(w7.used),
        ...(w7.resetsAt && w7.resetsAt > now ? { resetsAt: w7.resetsAt } : {}),
        span: w7.span || SEVEN_DAY_SECS,
        aside: true,
      })
      addedForNode++
    }

    for (const mw of s.modelWindows) {
      if (mw.used === null) continue
      const is5h = mw.kind === "model_five_hour"
      const scopeLabel = formatSubScopeLabel(mw.model, mw.name)
      const label = scopeLabel ? `${is5h ? "5 hours" : "7 days"} · ${scopeLabel}` : mw.name
      rows.push({
        name: `${prefix} · ${label}`,
        used: round1(mw.used),
        ...(mw.resetsAt && mw.resetsAt > now ? { resetsAt: mw.resetsAt } : {}),
        span: mw.span || (is5h ? FIVE_HOUR_SECS : SEVEN_DAY_SECS),
        aside: true,
      })
      addedForNode++
    }

    // Any other numeric windows on this node (e.g. Ollama monthly, Cursor pools)
    for (const ow of node.windows) {
      if (
        ow.used === null ||
        ow.kind === "five_hour" ||
        ow.kind === "seven_day" ||
        ow.kind === "model_five_hour" ||
        ow.kind === "model_seven_day"
      ) {
        continue
      }
      rows.push({
        name: `${prefix} · ${ow.name}`,
        used: round1(ow.used),
        ...(ow.resetsAt && ow.resetsAt > now ? { resetsAt: ow.resetsAt } : {}),
        ...(ow.span > 0 ? { span: ow.span } : {}),
        ...(ow.limit > 0 ? { amount: ow.amount ?? 0, limit: ow.limit, unit: ow.unit } : {}),
        aside: true,
      })
      addedForNode++
    }

    if (addedForNode === 0) {
      rows.push({
        name: prefix,
        display: node.status === "quota_exhausted" ? "Quota exhausted" : "Collecting quota…",
        aside: true,
      })
    }
  }

  for (const node of unavailableNodes) {
    const prefix = formatNodeTitle(node)
    const reason = node.rawStatus ? node.rawStatus.replace(/[_-]+/g, " ") : "offline"
    rows.push({
      name: prefix,
      display: `Unavailable (${reason})`,
      aside: true,
    })
  }

  return rows
}

function emitPoolWindows(poolStates, totalPoolCount, { mode, now, namePrefix = "", models = undefined, model = undefined }) {
  const windows = []
  const agg5 = aggregateWindowDimension(poolStates, "five_hour", { mode })
  const agg7 = aggregateWindowDimension(poolStates, "seven_day", { mode })

  const scopeFields = {}
  if (Array.isArray(models) && models.length > 0) scopeFields.models = models
  else if (model) scopeFields.model = model

  const title5 = namePrefix ? `${namePrefix} · 5 hours` : "5 hours"
  const title7 = namePrefix ? `${namePrefix} · 7 days` : "7 days"

  if (agg5.known) {
    const display = formatPoolDisplay(poolStates, totalPoolCount, agg5, mode)
    windows.push({
      name: title5,
      used: agg5.used,
      ...(agg5.resetsAt ? { resetsAt: agg5.resetsAt } : {}),
      span: FIVE_HOUR_SECS,
      ...(display ? { display } : {}),
      ...scopeFields,
    })
  }

  if (agg7.known) {
    const display = formatPoolDisplay(poolStates, totalPoolCount, agg7, mode)
    windows.push({
      name: title7,
      used: agg7.used,
      ...(agg7.resetsAt ? { resetsAt: agg7.resetsAt } : {}),
      span: SEVEN_DAY_SECS,
      ...(display ? { display } : {}),
      ...scopeFields,
    })
  }

  // Handle accounts with non-5h/7d windows (e.g. Ollama monthly or Cursor Auto/API pools)
  if (!agg5.known && !agg7.known) {
    const otherKinds = new Map()
    for (const s of poolStates) {
      for (const w of s.node.windows) {
        if (w.used === null) continue
        const key = `${w.kind}:${w.name}`
        if (!otherKinds.has(key)) otherKinds.set(key, [])
        otherKinds.get(key).push({ s, w })
      }
    }
    if (otherKinds.size > 0) {
      for (const items of otherKinds.values()) {
        const first = items[0].w
        const pseudo = items.map(({ s, w }) => ({
          ...s,
          has5: true,
          eff5: w.used,
          resetsAt5: w.resetsAt,
          unblockAt5: w.resetsAt,
        }))
        const agg = aggregateWindowDimension(pseudo, "five_hour", { mode })
        if (!agg.known) continue
        const name = namePrefix ? `${namePrefix} · ${first.name}` : first.name
        windows.push({
          name,
          used: agg.used,
          ...(agg.resetsAt ? { resetsAt: agg.resetsAt } : {}),
          ...(first.span > 0 ? { span: first.span } : {}),
          ...(items.length === 1 && first.limit > 0
            ? { amount: first.amount ?? 0, limit: first.limit, unit: first.unit }
            : {}),
          ...scopeFields,
        })
      }
    } else {
      // Collecting / unknown quota: leave `used` out so Magpie treats as unknown, NOT 0% free!
      windows.push({
        name: title5,
        display: "Collecting quota…",
        span: FIVE_HOUR_SECS,
        ...scopeFields,
      })
    }
  }

  const subWindows = aggregateModelSubWindows(poolStates, {
    mode,
    now,
    namePrefix,
  })
  windows.push(...subWindows)

  return windows
}

/**
 * Convert parsed CC Host `/v1/usage` snapshot into a Magpie `auth.usage` result.
 *
 * Handles:
 * 1. Single subscription node -> 1:1 5h + 7d windows (+ model sub-windows).
 * 2. Homogeneous multi-subscription aggregation (same account type / shared groups)
 *    -> capacity-weighted (or min/max/average) 5h + 7d windows with cross-window
 *    blocking coupling and exact earliest-recovery / soonest-expiry reset times.
 * 3. Heterogeneous multi-type aggregation (e.g. Claude + Codex + Gemini in one endpoint)
 *    -> per-type (and overlap-aware) scoped windows (`models: [...]`) so exhausting
 *    Claude never blocks Codex in Magpie's router.
 * 4. Unavailable / collecting / PAYG API-key nodes -> never invent 0% free quota.
 */
export function aggregateCchostUsage(
  parsed,
  {
    now = Date.now(),
    aggregation = "weighted",
    crossWindowCoupling = true,
    showNodeBreakdown = false,
    forceGlobalWindows = false,
    includePaygNote = true,
    catalogModels = [],
    label = "",
  } = {},
) {
  const user = label || parsed.endpointName || undefined
  const allNodes = parsed.nodes ?? []

  if (allNodes.length === 0) {
    if (parsed.summaryMaxUtilization !== null) {
      return {
        ...(user ? { user } : {}),
        plan: "CC Host",
        windows: [
          {
            name: "5 hours",
            used: round1(parsed.summaryMaxUtilization),
            span: FIVE_HOUR_SECS,
            display: "Summary max",
          },
        ],
        signIn: "kept",
      }
    }
    return {
      ...(user ? { user } : {}),
      error: "No accounts associated with this CC Host endpoint",
      windows: [],
      signIn: "kept",
    }
  }

  const paygNodes = allNodes.filter((n) => n.isPayg && n.status !== "unavailable")
  const unavailableNodes = allNodes.filter((n) => n.status === "unavailable")
  const activeSubNodes = allNodes.filter((n) => !n.isPayg && n.status !== "unavailable")

  if (activeSubNodes.length === 0) {
    if (paygNodes.length > 0) {
      return {
        ...(user ? { user } : {}),
        plan: `API Key ×${paygNodes.length}`,
        windows: [
          {
            name: "Pay-as-you-go",
            display: "No 5h/7d quota window (API key nodes)",
            aside: true,
          },
        ],
        signIn: "kept",
      }
    }
    return {
      ...(user ? { user } : {}),
      plan: `0/${allNodes.length} ready`,
      error: `No healthy nodes (0/${allNodes.length} ready)`,
      windows: [],
      signIn: "kept",
    }
  }

  const evaluated = activeSubNodes.map((n) =>
    evaluateNodeEffectiveState(n, { now, crossWindowCoupling }),
  )

  const subTypes = [...new Set(activeSubNodes.map((n) => n.accountType))].sort()
  const plan = buildPlanSummary(activeSubNodes, unavailableNodes.length, paygNodes)
  const resets = aggregateResetsVouchers(activeSubNodes)

  let windows = []

  if (subTypes.length === 1 || forceGlobalWindows) {
    // Homogeneous endpoint (single account or aggregated accounts of the same vendor):
    // emit canonical unscoped "5 hours" and "7 days" windows so Magpie treats this
    // endpoint identically to a native subscription.
    const totalSameType = allNodes.filter((n) => !n.isPayg).length
    windows = emitPoolWindows(evaluated, totalSameType, {
      mode: aggregation,
      now,
    })
  } else {
    // Heterogeneous endpoint (multiple subscription types behind one CC Host endpoint):
    // emit model-scoped windows per pool (including overlap pools when e.g. both Claude
    // and Gemini serve `claude-sonnet-4-6`) so exhausting one vendor never blocks another.
    const modelPoolMap = buildModelPoolRoutingMap(activeSubNodes, catalogModels)
    const coveredTypes = new Set()

    if (modelPoolMap.size > 0) {
      for (const { types, models } of modelPoolMap.values()) {
        for (const t of types) coveredTypes.add(t)
        const typeSet = new Set(types)
        const poolStates = evaluated.filter((s) => typeSet.has(s.node.accountType))
        const totalInTypes = allNodes.filter(
          (n) => !n.isPayg && typeSet.has(n.accountType),
        ).length
        const poolName = types.map((t) => ACCOUNT_TYPE_LABELS[t] ?? t).join(" + ")
        windows.push(
          ...emitPoolWindows(poolStates, totalInTypes, {
            mode: aggregation,
            now,
            namePrefix: poolName,
            models,
          }),
        )
      }
    }

    // Fallback for any account type whose models aren't in catalog yet
    for (const type of subTypes) {
      if (coveredTypes.has(type)) continue
      const poolStates = evaluated.filter((s) => s.node.accountType === type)
      const totalInType = allNodes.filter((n) => n.accountType === type).length
      const poolName = ACCOUNT_TYPE_LABELS[type] ?? type
      const keyword =
        type === "claude"
          ? "claude"
          : type === "codex"
            ? "gpt"
            : type === "gemini"
              ? "gemini"
              : type === "grok"
                ? "grok"
                : type === "kimi"
                  ? "kimi"
                  : undefined
      windows.push(
        ...emitPoolWindows(poolStates, totalInType, {
          mode: aggregation,
          now,
          namePrefix: poolName,
          model: keyword,
        }),
      )
    }
  }

  if (includePaygNote && paygNodes.length > 0) {
    const paygNames = paygNodes.map((n) => ACCOUNT_TYPE_LABELS[n.accountType] ?? n.accountType)
    windows.push({
      name: `${[...new Set(paygNames)].join(" / ")} (API Key)`,
      display: `Pay-as-you-go · ${paygNodes.length} node${paygNodes.length > 1 ? "s" : ""}`,
      aside: true,
    })
  }

  if (showNodeBreakdown && (evaluated.length > 1 || (evaluated.length >= 1 && unavailableNodes.length > 0))) {
    windows.push(...buildExpandedNodeWindows(evaluated, unavailableNodes, now))
  }

  return {
    plan,
    ...(user ? { user } : {}),
    ...(resets ? { resets } : {}),
    windows,
    signIn: "renewed",
  }
}

/**
 * Build a standalone Magpie `auth.usage` card for ONE specific upstream node
 * inside a multi-account CC Host endpoint (Option B: 1 card per upstream account).
 */
export function buildSingleNodeUsage(
  parsed,
  {
    nodeId = "",
    nodeName = "",
    now = Date.now(),
    label = "",
    crossWindowCoupling = false,
  } = {},
) {
  const allNodes = parsed?.nodes ?? []
  const needleId = String(nodeId ?? "").trim()
  const needleName = String(nodeName ?? "").trim().toLowerCase()

  const node =
    (needleId && allNodes.find((n) => n.id === needleId)) ||
    (needleName && allNodes.find((n) => (n.name || "").toLowerCase() === needleName)) ||
    null

  const fallbackUser = label || nodeName || nodeId || parsed?.endpointName || undefined

  if (!node) {
    return {
      ...(fallbackUser ? { user: fallbackUser } : {}),
      error: `Upstream account "${nodeName || nodeId}" is no longer in this CC Host endpoint (re-import to refresh)`,
      windows: [],
      signIn: "kept",
    }
  }

  const typeLabel = ACCOUNT_TYPE_LABELS[node.accountType] ?? node.accountType
  const user = label || (parsed.endpointName ? `${parsed.endpointName} · ${node.name}` : node.name)
  let plan = node.plan ? `${typeLabel} ${node.plan}` : typeLabel
  if (node.isGroup && node.totalCount !== null) {
    plan = `${typeLabel} Group (${node.readyCount ?? 0}/${node.totalCount} ready)`
  }

  if (node.status === "unavailable") {
    const reason = node.rawStatus ? node.rawStatus.replace(/[_-]+/g, " ") : "offline"
    return {
      plan,
      user,
      error: `Account unavailable (${reason})`,
      windows: [],
      signIn: "kept",
    }
  }

  if (node.isPayg) {
    return {
      plan: `${typeLabel} API Key`,
      user,
      windows: [
        {
          name: "Pay-as-you-go",
          display: "No 5h/7d quota window (API key node)",
          aside: true,
        },
      ],
      signIn: "renewed",
    }
  }

  const state = evaluateNodeEffectiveState(node, { now, crossWindowCoupling })
  const windows = []

  const w5 = node.windows.find((w) => w.kind === "five_hour")
  const w7 = node.windows.find((w) => w.kind === "seven_day")

  if (w5 && w5.used !== null) {
    windows.push({
      name: "5 hours",
      used: round1(crossWindowCoupling ? state.eff5 : w5.used),
      ...(w5.resetsAt && w5.resetsAt > now ? { resetsAt: w5.resetsAt } : {}),
      span: w5.span || FIVE_HOUR_SECS,
    })
  } else if (state.raw5 !== null) {
    windows.push({
      name: "5 hours",
      used: round1(crossWindowCoupling ? state.eff5 : state.raw5),
      span: FIVE_HOUR_SECS,
    })
  }

  if (w7 && w7.used !== null) {
    windows.push({
      name: "7 days",
      used: round1(crossWindowCoupling ? state.eff7 : w7.used),
      ...(w7.resetsAt && w7.resetsAt > now ? { resetsAt: w7.resetsAt } : {}),
      span: w7.span || SEVEN_DAY_SECS,
    })
  }

  for (const mw of state.modelWindows) {
    if (mw.used === null) continue
    const is5h = mw.kind === "model_five_hour"
    const scopeLabel = formatSubScopeLabel(mw.model, mw.name)
    windows.push({
      name: `${is5h ? "5 hours" : "7 days"} · ${scopeLabel || mw.name}`,
      used: round1(mw.used),
      ...(mw.resetsAt && mw.resetsAt > now ? { resetsAt: mw.resetsAt } : {}),
      span: mw.span || (is5h ? FIVE_HOUR_SECS : SEVEN_DAY_SECS),
      ...(mw.model ? { model: mw.model } : {}),
    })
  }

  for (const ow of node.windows) {
    if (
      ow.used === null ||
      ow.kind === "five_hour" ||
      ow.kind === "seven_day" ||
      ow.kind === "model_five_hour" ||
      ow.kind === "model_seven_day"
    ) {
      continue
    }
    windows.push({
      name: ow.name,
      used: round1(ow.used),
      ...(ow.resetsAt && ow.resetsAt > now ? { resetsAt: ow.resetsAt } : {}),
      ...(ow.span > 0 ? { span: ow.span } : {}),
      ...(ow.limit > 0 ? { amount: ow.amount ?? 0, limit: ow.limit, unit: ow.unit } : {}),
    })
  }

  if (windows.length === 0) {
    windows.push({
      name: "5 hours",
      display: node.status === "quota_exhausted" ? "Quota exhausted" : "Collecting quota…",
      span: FIVE_HOUR_SECS,
    })
  }

  const resets = aggregateResetsVouchers([node])

  return {
    plan,
    user,
    ...(resets ? { resets } : {}),
    windows,
    signIn: "renewed",
  }
}
