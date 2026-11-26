import { normalizeBaseUrl } from "./config.mjs"

function combineSignals(signal, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(
    () => ctl.abort(new Error(`CC Host request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const onAbort = () => ctl.abort(signal.reason ?? new DOMException("Aborted", "AbortError"))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: ctl.signal,
    cleanup() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
    },
  }
}

async function readErrorMessage(res) {
  try {
    const text = await res.text()
    if (!text) return `HTTP ${res.status}`
    try {
      const json = JSON.parse(text)
      const msg =
        json?.error?.message ??
        json?.message ??
        (typeof json?.error === "string" ? json.error : "")
      if (msg) return String(msg)
    } catch {
      // plain text body
    }
    return text.slice(0, 300)
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function fetchCchostUsage(baseUrl, apiKey, { signal, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) throw new Error("CC Host endpoint Base URL is not configured")
  if (!apiKey) throw Object.assign(new Error("CC Host API key is missing"), { signIn: "expired" })

  const { signal: combined, cleanup } = combineSignals(signal, timeoutMs)
  try {
    const res = await fetchImpl(`${base}/v1/usage`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      signal: combined,
    })

    if (res.status === 401) {
      const msg = await readErrorMessage(res)
      const err = new Error(`CC Host authentication failed (401): ${msg}`)
      err.status = 401
      err.signIn = "expired"
      throw err
    }

    if (!res.ok) {
      const msg = await readErrorMessage(res)
      const err = new Error(`CC Host /v1/usage answered ${res.status}: ${msg}`)
      err.status = res.status
      err.signIn = "kept"
      throw err
    }

    return await res.json()
  } finally {
    cleanup()
  }
}

export async function fetchCchostModels(baseUrl, apiKey, { signal, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) throw new Error("CC Host endpoint Base URL is not configured")
  if (!apiKey) throw Object.assign(new Error("CC Host API key is missing"), { signIn: "expired" })

  const { signal: combined, cleanup } = combineSignals(signal, timeoutMs)
  try {
    const res = await fetchImpl(`${base}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      signal: combined,
    })

    if (res.status === 401) {
      const msg = await readErrorMessage(res)
      const err = new Error(`CC Host authentication failed (401): ${msg}`)
      err.status = 401
      err.signIn = "expired"
      throw err
    }

    if (!res.ok) {
      const msg = await readErrorMessage(res)
      const err = new Error(`CC Host /v1/models answered ${res.status}: ${msg}`)
      err.status = res.status
      err.signIn = "kept"
      throw err
    }

    return await res.json()
  } finally {
    cleanup()
  }
}

/**
 * Create a short-TTL + in-flight coalescing wrapper around `fetchCchostUsage`.
 * When 1 CC Host endpoint is split into N+1 Magpie cards (1 primary endpoint +
 * N per-node cards), Magpie's Usage page refreshes all cards simultaneously;
 * coalescing guarantees only 1 HTTP `GET /v1/usage` request hits CC Host and
 * all sibling cards show a consistent snapshot.
 */
export function createCoalescedUsageFetcher({ ttlMs = 3000, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map() // key -> { at, data }
  const inflight = new Map() // key -> Promise

  return async function getUsage(baseUrl, apiKey, opts = {}) {
    const base = normalizeBaseUrl(baseUrl)
    const key = `${base}\0${apiKey}`
    const t = now()

    if (ttlMs > 0) {
      const hit = cache.get(key)
      if (hit && t - hit.at < ttlMs) {
        return hit.data
      }
    }

    const pending = inflight.get(key)
    if (pending) {
      return await pending
    }

    // Do not bind a single caller's abort signal to the shared upstream request
    // when multiple cards coalesce; still honor timeoutMs.
    const p = fetchCchostUsage(base, apiKey, {
      timeoutMs: opts.timeoutMs ?? 15000,
      fetchImpl: opts.fetchImpl ?? fetchImpl,
      signal: opts.shared ? undefined : opts.signal,
    }).then(
      (data) => {
        if (ttlMs > 0) cache.set(key, { at: now(), data })
        inflight.delete(key)
        return data
      },
      (err) => {
        inflight.delete(key)
        throw err
      },
    )

    inflight.set(key, p)
    return await p
  }
}

/**
 * Create the `fetch` wrapper returned by `auth.loader`:
 * - sends exactly ONE auth header (`x-api-key` for Anthropic `/messages*`,
 *   `Authorization: Bearer` for OpenAI `/responses*` and `/chat/completions*`),
 *   per CC Host docs ("以下两种方式任选其一，不需要同时发送")
 * - preserves/attaches session stickiness where safe
 * - sets `X-Magpie-Sign-In` accurately so 401 marks key expired while 404/429/502
 *   (`[cchost] No healthy nodes`) never falsely revoke the endpoint's API key!
 */
export function createCchostFetch(getAuth, pluginOptions, fetchImpl = globalThis.fetch) {
  return async function cchostFetch(input, init = {}) {
    const auth = await getAuth()
    const apiKey = typeof auth?.key === "string" ? auth.key.trim() : ""
    if (!apiKey) {
      throw Object.assign(new Error("CC Host API key is missing; sign in again"), {
        signIn: "expired",
      })
    }

    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const parsedUrl = new URL(urlStr)
    const isAnthropicPath = /\/messages(?:\/count_tokens)?$/.test(parsedUrl.pathname)

    const headers = new Headers(init.headers)
    headers.delete("authorization")
    headers.delete("x-api-key")

    if (isAnthropicPath) {
      headers.set("x-api-key", apiKey)
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01")
      }
    } else {
      headers.set("authorization", `Bearer ${apiKey}`)
    }

    // Read Magpie's internal session header (host.js strips it before sending upstream)
    // and ensure CC Host can pin conversations for better cache hit rate when safe.
    const magpieSession = headers.get("x-magpie-session")
    let body = init.body
    if (magpieSession && typeof body === "string" && body.trim().startsWith("{")) {
      try {
        const json = JSON.parse(body)
        if (isAnthropicPath && !json.metadata?.user_id && !parsedUrl.pathname.endsWith("/count_tokens")) {
          json.metadata = { ...(json.metadata ?? {}), user_id: magpieSession }
          body = JSON.stringify(json)
        } else if (!isAnthropicPath && !json.prompt_cache_key && parsedUrl.pathname.endsWith("/responses")) {
          json.prompt_cache_key = magpieSession
          body = JSON.stringify(json)
        }
      } catch {
        // leave body untouched if not JSON
      }
    }

    const res = await fetchImpl(urlStr, {
      ...init,
      headers,
      body,
    })

    // Classify sign-in status explicitly for Magpie
    if (res.status === 401) {
      const rh = new Headers(res.headers)
      rh.set("x-magpie-sign-in", "expired")
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: rh,
      })
    }

    if (res.status === 403 || res.status === 404 || res.status === 429 || res.status >= 500) {
      const rh = new Headers(res.headers)
      if (!rh.has("x-magpie-sign-in")) rh.set("x-magpie-sign-in", "kept")
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: rh,
      })
    }

    return res
  }
}
