/**
 * Faithful local simulator of Magpie's plugin host (`internal/plugin/host.js`),
 * plugin usage converter (`internal/provider/plugin_usage.go`),
 * routing allowance (`internal/provider/routing.go`), and
 * Smart routing strategy (`internal/routes/strategies.go`).
 *
 * Used strictly in local unit/integration tests to verify 100% parity with
 * Magpie's real runtime contracts without requiring online calls or Bun.
 */

const BUDGET_SPAN_MS = 24 * 3600 * 1000
const LOW_SHARE = 90
const USED_SHARE = 100

/**
 * Mirrors `servers(mod)` in `internal/plugin/host.js`:
 * ensures only intended plugin functions are exported.
 */
export function hostExtractServers(mod) {
  const d = mod.default
  if (d && typeof d === "object" && ("server" in d || "id" in d || "tui" in d)) {
    return typeof d.server === "function" ? [d.server] : []
  }
  const seen = new Set()
  const out = []
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue
    seen.add(v)
    if (typeof v === "function") out.push(v)
    else if (v && typeof v === "object" && typeof v.server === "function") out.push(v.server)
  }
  return out
}

/**
 * Mirrors `usageOf` normalization in `internal/plugin/host.js` lines 3385-3432.
 */
export function hostNormalizeUsage(u = {}) {
  const when = (v) => {
    if (v === undefined || v === null || v === "") return ""
    const d = new Date(typeof v === "number" && v < 1e11 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? "" : d.toISOString()
  }
  const text = (v) => (typeof v === "string" ? v : "")
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])

  return {
    plan: text(u.plan),
    until: when(u.until),
    renew: u.renew === "auto" || u.renew === "off" ? u.renew : "",
    balance: text(u.balance),
    error: text(u.error),
    user: text(u.user),
    signIn: ["expired", "kept", "renewed"].includes(u.signIn) ? u.signIn : "",
    resets:
      u.resets && typeof u.resets === "object"
        ? {
            count: num(u.resets.count),
            until: when(u.resets.until),
            byWindow: !!u.resets.byWindow,
            fiveHour: num(u.resets.fiveHour),
            weekly: num(u.resets.weekly),
            team: !!u.resets.team,
            each: (Array.isArray(u.resets.each) ? u.resets.each : [])
              .filter((r) => r && typeof r === "object")
              .map((r) => ({
                until: when(r.until),
                window: r.window === "fiveHour" || r.window === "weekly" ? r.window : "",
              })),
          }
        : null,
    windows: (Array.isArray(u.windows) ? u.windows : []).map((w) => ({
      name: text(w?.name),
      used: w?.used == null ? null : Math.max(0, num(w?.used)),
      resetsAt: when(w?.resetsAt),
      resetSecs: Math.max(0, Math.round(num(w?.resetSecs))),
      display: text(w?.display),
      amount: Math.max(0, num(w?.amount)),
      limit: Math.max(0, num(w?.limit)),
      unit: text(w?.unit),
      span: Math.max(0, num(w?.span)),
      model: text(w?.model),
      models: ids(w?.models),
      notModels: ids(w?.notModels),
      family: text(w?.family),
      pool: text(w?.pool),
      aside: !!w?.aside,
      runsOutAt: when(w?.runsOutAt),
      runsOut: Math.max(0, num(w?.runsOut)),
      credits: !!w?.credits,
      balance: typeof w?.balance === "number" && Number.isFinite(w.balance) ? Math.max(0, w.balance) : null,
    })),
  }
}

/**
 * Mirrors `idSetOf` in `internal/provider/plugin_usage.go`.
 */
function makeIdSet(list) {
  if (!list || list.length === 0) return null
  const ids = new Set()
  const bare = new Set()
  const bareOf = (id) => {
    const i = id.lastIndexOf("@")
    return i > 0 ? id.slice(0, i) : null
  }
  for (const raw of list) {
    const id = raw.toLowerCase()
    ids.add(id)
    const b = bareOf(id)
    if (b) bare.add(b)
  }
  return (model) => {
    const m = model.toLowerCase()
    if (ids.has(m)) return true
    const b = bareOf(m)
    if (b && ids.has(b)) return true
    return bare.has(m)
  }
}

/**
 * Mirrors `quotaOfPlugin` in `internal/provider/plugin_usage.go`.
 */
export function goQuotaOfPlugin(hostUsage) {
  const windows = []
  for (const x of hostUsage.windows) {
    const w = {
      name: x.name,
      resetSecs: x.resetSecs,
      display: x.display,
      amount: x.amount,
      limit: x.limit,
      unit: x.unit,
      spanMs: x.span * 1000,
      model: x.model.toLowerCase(),
      aside: x.aside,
      pool: x.pool,
      family: x.family,
      balance: x.balance,
      used: 0,
      text: false,
      credits: false,
      resetsAt: x.resetsAt ? Date.parse(x.resetsAt) : null,
      matches: null,
    }

    let used = x.used
    if (used === null && x.limit > 0 && x.amount > 0 && x.balance === null) {
      used = (x.amount / x.limit) * 100
    }
    if (used !== null) {
      w.used = used
    } else if (!x.aside && x.balance === null) {
      w.text = true
      w.aside = true
    }

    w.text =
      w.text ||
      (x.aside &&
        x.display !== "" &&
        (used === null || used === 0) &&
        x.amount === 0 &&
        x.limit === 0 &&
        x.balance === null)

    if (x.credits && used !== null && !w.text) {
      w.aside = false
      w.credits = true
    }

    const pos = makeIdSet(x.models)
    const neg = makeIdSet(x.notModels)
    if (pos) w.matches = pos
    else if (neg) w.matches = (m) => !neg(m)

    windows.push(w)
  }

  return {
    plan: hostUsage.plan,
    user: hostUsage.user,
    error: hostUsage.error,
    signIn: hostUsage.signIn,
    resets: hostUsage.resets,
    windows,
  }
}

/**
 * Mirrors `allowanceOf` + `Allowance.For` / `Full` / `Pooled` / `Renewal`
 * in `internal/provider/routing.go`.
 */
export function goAllowanceOf(quota, nowMs) {
  const limits = []
  for (const w of quota.windows) {
    if (w.aside || w.text) continue
    const resets =
      w.resetsAt ?? (w.resetSecs > 0 ? nowMs + w.resetSecs * 1000 : 0)
    limits.push({
      used: w.used,
      spanMs: w.spanMs,
      model: w.model,
      matches: w.matches,
      name: w.name,
      resets,
    })
  }

  const applies = (l, model) => {
    const m = model.toLowerCase()
    return (l.model === "" || m.includes(l.model)) && (!l.matches || l.matches(m))
  }

  return {
    limits,
    known: limits.length > 0,

    forModel(model, now = nowMs) {
      let used = 0
      const ls = []
      for (const l of limits) {
        if (!applies(l, model)) continue
        let u = l.used
        let r = l.resets
        if (r > 0 && r <= now) {
          u = 0
          r = 0
        }
        used = Math.max(used, u)
        ls.push({ ...l, used: u, resets: r })
      }
      ls.sort((a, b) => (a.spanMs !== b.spanMs ? b.spanMs - a.spanMs : b.resets - a.resets))
      return { used, renews: ls.map((x) => x.resets) }
    },

    capUsed(model, now = nowMs) {
      let used = 0
      for (const l of limits) {
        if (!applies(l, model) || l.spanMs >= BUDGET_SPAN_MS) continue
        if (l.resets > 0 && l.resets <= now) continue
        used = Math.max(used, l.used)
      }
      return used
    },

    full(model, share = USED_SHARE, now = nowMs) {
      let back = 0
      for (const l of limits) {
        if (applies(l, model) && l.used >= share && l.resets > now && l.resets > back) {
          back = l.resets
        }
      }
      return back
    },

    pooled(model, share = USED_SHARE, now = nowMs) {
      let full = false
      let pooled = false
      let whole = false
      for (const l of limits) {
        if (!applies(l, model)) continue
        const scoped = l.model !== "" || l.matches !== null
        if (l.used >= share && (l.resets === 0 || l.resets > now)) {
          if (!scoped) return false
          full = true
        }
        pooled = pooled || scoped
        whole = whole || !scoped
      }
      return full || (pooled && !whole)
    },

    renewal(model, now = nowMs) {
      const ls = []
      for (const l of limits) {
        if (!applies(l, model)) continue
        let r = l.resets
        if (r <= now) {
          r = l.spanMs > 0 ? now + l.spanMs : 0
        }
        ls.push({ spanMs: l.spanMs, resets: r })
      }
      ls.sort((a, b) => (a.spanMs !== b.spanMs ? b.spanMs - a.spanMs : b.resets - a.resets))
      return ls.map((x) => x.resets)
    },
  }
}

/**
 * Mirrors Magpie's `routes.Smart` seat ordering (`internal/routes/strategies.go`):
 * fine (<90 or week-only low) ordered by soonest biggest-window renewal (to the hour),
 * then low (5h >= 90), then spent (>= 100).
 */
export function goSmartOrder(seats, model, nowMs) {
  const weighed = seats.map((s, idx) => {
    const { used } = s.allowance.forModel(model, nowMs)
    const cap = s.allowance.capUsed(model, nowMs)
    const soon = s.allowance.renewal(model, nowMs)
    const weekLow = used >= LOW_SHARE && cap < LOW_SHARE
    let tier = 0
    if (used >= USED_SHARE) tier = 2
    else if (used >= LOW_SHARE && !weekLow) tier = 1
    return { idx, id: s.id, used, soon, tier }
  })

  const truncHour = (ms) => (ms > 0 ? Math.floor(ms / 3600_000) * 3600_000 : 0)

  const fine = weighed.filter((x) => x.tier === 0)
  const low = weighed.filter((x) => x.tier === 1)
  const spent = weighed.filter((x) => x.tier === 2)

  fine.sort((a, b) => {
    const len = Math.max(a.soon.length, b.soon.length)
    for (let k = 0; k < len; k++) {
      const x = truncHour(a.soon[k] ?? 0)
      const y = truncHour(b.soon[k] ?? 0)
      if (x === y) continue
      if (x === 0 || y === 0) return y === 0 ? -1 : 1
      return x - y
    }
    return a.idx - b.idx
  })
  low.sort((a, b) => a.used - b.used || a.idx - b.idx)
  spent.sort((a, b) => a.used - b.used || a.idx - b.idx)

  return [...fine, ...low, ...spent].map((x) => x.id)
}

/**
 * Mirrors `whoOf`, `secretOf`, `settle`, and `importFiles` in `internal/plugin/host.js`
 * so we can verify multi-card split imports with a shared CC Host API key.
 */
export function hostWhoOf(a) {
  return a?.accountId ?? a?.metadata?.email ?? a?.email ?? ""
}

export function hostApplyImport(authStore, providerId, importResults) {
  const out = { ...authStore }
  const summary = []
  let seq = Object.keys(out).length

  const freshKey = () => {
    if (!(providerId in out)) return providerId
    while (true) {
      seq++
      const k = `${providerId}#s${seq}`
      if (!(k in out)) return k
    }
  }

  for (const r of importResults) {
    if (!r || r.type !== "success") {
      summary.push({ status: "failed", error: r?.error ?? "failed" })
      continue
    }
    const now = { type: "api", key: r.key, ...(r.metadata ? { metadata: r.metadata } : {}) }
    const who = hostWhoOf(now)
    let matchedKey = null
    for (const [k, was] of Object.entries(out)) {
      if (k !== providerId && !k.startsWith(`${providerId}#`)) continue
      const wasWho = hostWhoOf(was)
      if ((who && wasWho === who) || (!who && !wasWho && now.key && was.key === now.key)) {
        matchedKey = k
        break
      }
    }
    if (matchedKey) {
      out[matchedKey] = now
      summary.push({ status: "updated", account: matchedKey, user: who })
    } else {
      const k = freshKey()
      out[k] = now
      summary.push({ status: "added", account: k, user: who })
    }
  }
  return { authStore: out, results: summary }
}

/**
 * Mirrors `makeClient().auth.set` + `keyFor` + `save` + `settle` in `internal/plugin/host.js`
 * so we can test direct Method 0 sign-in splitting into multiple cards with zero file import.
 */
export function hostCreateSignInHarness(providerId, initialAuthStore = {}) {
  let authStore = { ...initialAuthStore }
  let activeScope = null

  const keyFor = (id) => (activeScope && activeScope.provider === id ? activeScope.key : id)

  const client = {
    auth: {
      set: async (opts) => {
        const id = opts?.path?.id ?? opts?.id ?? opts?.providerID
        const body = opts?.body ?? opts?.auth
        if (typeof id === "string" && body && typeof body === "object") {
          const key = keyFor(id)
          authStore[key] = structuredClone(body)
        }
        return { data: true }
      },
      remove: async (opts) => {
        const id = opts?.path?.id ?? opts?.id
        if (typeof id === "string") delete authStore[keyFor(id)]
        return { data: true }
      },
    },
  }

  return {
    client,
    getAuthStore: () => authStore,
    async runApiAuthorize(method, inputs) {
      const slot = !(providerId in authStore)
        ? providerId
        : `${providerId}#a${Object.keys(authStore).length + 1}`
      activeScope = { provider: providerId, key: slot }
      try {
        const r = await method.authorize(inputs)
        if (!r || r.type !== "success") return r
        const applied = hostApplyImport(authStore, providerId, [r])
        authStore = applied.authStore
        return { ...r, savedAccount: applied.results[0]?.account }
      } finally {
        activeScope = null
      }
    },
  }
}

/**
 * Mirrors `pluginServedCatalog` and `Account.pluginLists` in `internal/provider/plugins.go`.
 */
export function goPluginAccountRouting(accountModelsByKey) {
  const entries = Object.entries(accountModelsByKey)
  const multiple = entries.length > 1
  const accounts = entries.map(([key, map]) => ({
    key,
    fellBack: map?.[Symbol.for("magpie.fellBack")] === true,
    models: multiple ? Object.keys(map ?? {}) : undefined,
  }))
  const unionModels = new Set()
  for (const a of accounts) {
    for (const id of a.models ?? Object.keys(accountModelsByKey[a.key] ?? {})) {
      unionModels.add(id)
    }
  }
  return {
    accounts,
    servedCatalog: [...unionModels],
    accountServes(key, modelId) {
      const a = accounts.find((x) => x.key === key)
      if (!a || a.fellBack || a.models === undefined) return true
      return a.models.includes(modelId)
    },
  }
}

/**
 * Mirrors `quotaText` in `internal/gui/assets/app.js` to verify no duplicate `%`
 * or broken rendering on Usage cards.
 */
export function guiQuotaText(w, showLeft = false) {
  if (w.text || (!w.aside && w.used === null && w.balance === null)) {
    return w.display || "No allowance reported"
  }
  const used = Math.min(100, Math.max(0, w.used))
  const n = showLeft ? 100 - used : used
  const pct = `${Number.isInteger(n) ? n : n.toFixed(1)}% ${showLeft ? "left" : "used"}`
  const count = w.limit > 0 ? `${w.amount} / ${w.limit}${w.unit ? " " + w.unit : ""}` : w.display || ""
  return count ? `${count} · ${pct}` : pct
}
