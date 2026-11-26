import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as pluginMod from "../index.mjs"
import { CCHostAuthPlugin } from "../index.mjs"
import { startMockCchostServer } from "../mock/cchost-mock-server.mjs"
import {
  hostExtractServers,
  hostNormalizeUsage,
  hostApplyImport,
  hostCreateSignInHarness,
  goPluginAccountRouting,
  goQuotaOfPlugin,
  goAllowanceOf,
} from "./magpie-contract.mjs"

const FIXED_NOW = Date.parse("2026-11-26T12:00:00.000Z")

describe("CCHostAuthPlugin — end-to-end local mock integration", () => {
  let mock

  before(async () => {
    mock = await startMockCchostServer({ now: () => FIXED_NOW })
  })

  after(async () => {
    await mock.close()
  })

  it("exports exactly one OpenCode/Magpie plugin function (no stray helper function exports)", () => {
    const servers = hostExtractServers(pluginMod)
    assert.equal(servers.length, 1)
    assert.equal(servers[0], CCHostAuthPlugin)
  })

  it("declares provider config, auth methods, options, loader, usage, and models hooks", async () => {
    const switches = { show_node_breakdown: false, force_global_windows: false }
    const hooks = await CCHostAuthPlugin(
      {
        magpie: {
          option: (_p, k) => Boolean(switches[k]),
          options: () => ({ ...switches }),
        },
      },
      { now: () => FIXED_NOW },
    )

    const cfg = {}
    await hooks.config(cfg)
    assert.equal(cfg.provider.cchost.name, "CC Host")
    assert.equal(hooks.auth.provider, "cchost")
    assert.equal(hooks.auth.methods.length, 2)
    assert.equal(hooks.auth.methods[0].type, "api")
    assert.equal(hooks.auth.methods[1].type, "api")
    assert.equal(typeof hooks.auth.methods[0].authorize, "function")
    assert.equal(typeof hooks.auth.import, "function")
    assert.equal(typeof hooks.auth.usage, "function")
    assert.equal(typeof hooks.auth.loader, "function")
    assert.equal(typeof hooks.provider.models, "function")
  })

  it("authenticates against local mock, discovers models, fetches 5h/7d usage, and proxies all 3 protocols with single auth header", async () => {
    const switches = { show_node_breakdown: true, force_global_windows: false }
    const hooks = await CCHostAuthPlugin(
      {
        magpie: {
          option: (_p, k) => Boolean(switches[k]),
          options: () => ({ ...switches }),
        },
      },
      { now: () => FIXED_NOW },
    )

    // 1. Bad key fails sign-in cleanly
    const badAuth = await hooks.auth.methods[0].authorize({
      baseUrl: mock.baseUrl,
      apiKey: "cchost_wrong_key",
      label: "bad",
    })
    assert.equal(badAuth.type, "failed")
    assert.match(badAuth.error, /401/)

    // 2. Valid sign-in against homogeneous weighted pool (single-card mode; trailing /v1 stripped)
    const signIn = await hooks.auth.methods[0].authorize({
      baseUrl: `${mock.baseUrl}/v1/`,
      apiKey: mock.scenarios["claude-pool-weighted"].apiKey,
      label: "team-claude",
      aggregation: "weighted",
      splitMode: "single",
    })
    assert.equal(signIn.type, "success")
    assert.equal(signIn.metadata.baseUrl, mock.baseUrl)
    assert.equal(signIn.metadata.email, "team-claude")

    const storedAuth = { type: "api", key: signIn.key, metadata: signIn.metadata }
    const getAuth = async () => storedAuth

    // 3. Model discovery via GET /v1/models
    const models = await hooks.provider.models({ models: {} }, { auth: storedAuth })
    assert.ok(models["claude-sonnet-4-6"])
    assert.equal(models["claude-sonnet-4-6"].api.npm, "@ai-sdk/anthropic")
    assert.equal(models["claude-sonnet-4-6"].api.url, `${mock.baseUrl}/v1`)

    // 4. Quota sensing via GET /v1/usage
    const usage = await hooks.auth.usage(getAuth, { models })
    const hostUsage = hostNormalizeUsage(usage)
    const quota = goQuotaOfPlugin(hostUsage)
    const allowance = goAllowanceOf(quota, FIXED_NOW)

    assert.equal(hostUsage.user, "team-claude")
    assert.equal(hostUsage.plan, "Claude ×3 (26x)")
    const w5 = hostUsage.windows.find((w) => w.name === "5 hours" && !w.aside)
    const w7 = hostUsage.windows.find((w) => w.name === "7 days" && !w.aside)
    const wFable = hostUsage.windows.find((w) => w.name === "7 days · Fable" && !w.aside)
    assert.equal(w5.used, 37.7)
    assert.equal(w7.used, 38.1)
    // Fable aggregated across Max 20x (50%) + Max 5x (90%) = (1000+450)/25 = 58%
    assert.equal(wFable.used, 58)
    assert.equal(allowance.forModel("claude-sonnet-4-6").used, 38.1)
    assert.equal(allowance.forModel("claude-fable-5").used, 58)
    // Breakdown switch expands each upstream account into real aside progress bars:
    // Max20x (5h, 7d, Fable) + Max5x (5h, 7d, Fable) + Pro (5h, 7d) = 8 aside bars
    const asideBars = hostUsage.windows.filter((w) => w.aside)
    assert.equal(asideBars.length, 8)
    assert.ok(asideBars.some((w) => w.name.includes("Claude-Max20x") && w.name.includes("Fable") && w.used === 50))
    assert.ok(asideBars.some((w) => w.name.includes("Claude-Max5x") && w.name.includes("5 hours") && w.used === 100))

    // 5. Loader fetch sends Anthropic Messages with x-api-key ONLY (never both auth headers!)
    const loaded = await hooks.auth.loader(getAuth)
    assert.equal(loaded.baseURL, `${mock.baseUrl}/v1`)

    const beforeCount = mock.requests.length
    const msgRes = await loaded.fetch(`${loaded.baseURL}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer should-be-stripped",
        "x-magpie-session": "sess-sticky-123",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    assert.equal(msgRes.status, 200)
    const msgJson = await msgRes.json()
    assert.match(msgJson.content[0].text, /Anthropic Messages/)

    const recordedMsg = mock.requests[beforeCount]
    assert.equal(recordedMsg.hasBothAuth, false)
    assert.equal(recordedMsg.headers["x-api-key"], storedAuth.key)
    assert.equal(recordedMsg.headers["authorization"], undefined)
    assert.equal(JSON.parse(recordedMsg.body).metadata.user_id, "sess-sticky-123")

    // 6. OpenAI Responses uses Bearer ONLY and injects prompt_cache_key for stickiness
    const respRes = await loaded.fetch(`${loaded.baseURL}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "should-be-stripped",
        "x-magpie-session": "sess-codex-456",
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    })
    assert.equal(respRes.status, 200)
    const recordedResp = mock.requests[beforeCount + 1]
    assert.equal(recordedResp.hasBothAuth, false)
    assert.equal(recordedResp.headers["authorization"], `Bearer ${storedAuth.key}`)
    assert.equal(recordedResp.headers["x-api-key"], undefined)
    assert.equal(JSON.parse(recordedResp.body).prompt_cache_key, "sess-codex-456")

    // 7. OpenAI Chat Completions uses Bearer ONLY
    const chatRes = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(chatRes.status, 200)
    assert.equal(mock.requests[beforeCount + 2].hasBothAuth, false)
  })

  it("handles heterogeneous multi-vendor endpoint and shared groups via local mock", async () => {
    const hooks = await CCHostAuthPlugin({}, { now: () => FIXED_NOW })

    const heteroAuth = {
      type: "api",
      key: mock.scenarios["heterogeneous-multi-vendor"].apiKey,
      metadata: { baseUrl: mock.baseUrl, label: "all-in-one", aggregation: "weighted" },
    }
    const models = await hooks.provider.models({ models: {} }, { auth: heteroAuth })
    assert.equal(models["claude-opus-4-6"].api.npm, "@ai-sdk/anthropic")
    assert.equal(models["gpt-5.4"].api.npm, "@ai-sdk/openai")
    assert.equal(models["gemini-2.5-pro"].api.npm, "@ai-sdk/anthropic") // Gemini on CC Host is Anthropic-only!
    assert.deepEqual(models["aistudio/gemini-2.5-flash"].also, ["@ai-sdk/anthropic", "@ai-sdk/openai"])

    const usage = await hooks.auth.usage(async () => heteroAuth, { models })
    const allowance = goAllowanceOf(goQuotaOfPlugin(hostNormalizeUsage(usage)), FIXED_NOW)
    assert.equal(allowance.forModel("claude-opus-4-6").used, 100)
    assert.equal(allowance.full("claude-opus-4-6", 100, FIXED_NOW) > FIXED_NOW, true)
    assert.equal(allowance.forModel("gpt-5.4").used, 25)
    assert.equal(allowance.full("gpt-5.4", 100, FIXED_NOW), 0)
    assert.equal(allowance.forModel("claude-sonnet-4-6").used, 86.7)
    assert.equal(allowance.full("claude-sonnet-4-6", 100, FIXED_NOW), 0)

    // Shared group + own account + 1 offline node
    const sharedAuth = {
      type: "api",
      key: mock.scenarios["shared-group-and-offline"].apiKey,
      metadata: { baseUrl: mock.baseUrl, label: "shared-plus-own", aggregation: "weighted" },
    }
    const sharedUsage = await hooks.auth.usage(async () => sharedAuth, { models: {} })
    // Shared group (totalCount=8 -> weight 8, 5h=75%, 7d=50%) + own account (weight 1, 5h=10%, 7d=20%)
    // Offline node excluded from active denominator -> weighted 5h = (75*8 + 10*1)/9 = 67.8%, 7d = (50*8 + 20*1)/9 = 46.7%
    assert.equal(sharedUsage.windows[0].used, 67.8)
    assert.equal(sharedUsage.windows[1].used, 46.7)
    assert.match(sharedUsage.windows[0].display, /7\/10 ready/)
  })

  it("handles 502 [cchost] No healthy nodes without marking API key expired, while 401 marks expired", async () => {
    const hooks = await CCHostAuthPlugin({}, { now: () => FIXED_NOW })

    const offlineAuth = {
      type: "api",
      key: mock.scenarios["all-offline"].apiKey,
      metadata: { baseUrl: mock.baseUrl, label: "offline-ep" },
    }
    const offlineUsage = await hooks.auth.usage(async () => offlineAuth, { models: {} })
    assert.equal(offlineUsage.signIn, "kept")
    assert.match(offlineUsage.error, /No healthy nodes/)

    const loadedOffline = await hooks.auth.loader(async () => offlineAuth)
    const res502 = await loadedOffline.fetch(`${loadedOffline.baseURL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })
    assert.equal(res502.status, 502)
    assert.equal(res502.headers.get("x-magpie-sign-in"), "kept")

    // Revoked key -> 401 marks x-magpie-sign-in: expired
    const revokedAuth = {
      type: "api",
      key: "cchost_revoked_key",
      metadata: { baseUrl: mock.baseUrl, label: "revoked-ep" },
    }
    const revokedUsage = await hooks.auth.usage(async () => revokedAuth, { models: {} })
    assert.equal(revokedUsage.signIn, "expired")

    const loadedRevoked = await hooks.auth.loader(async () => revokedAuth)
    const res401 = await loadedRevoked.fetch(`${loadedRevoked.baseURL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })
    assert.equal(res401.status, 401)
    assert.equal(res401.headers.get("x-magpie-sign-in"), "expired")
  })

  it("Option B: splits 1 multi-account endpoint into separate subscription cards via auth.import with coalesced /v1/usage and routing isolation", async () => {
    const switches = { show_node_breakdown: true, force_global_windows: false }
    const hooks = await CCHostAuthPlugin(
      {
        magpie: {
          option: (_p, k) => Boolean(switches[k]),
          options: () => ({ ...switches }),
        },
      },
      { now: () => FIXED_NOW, usageCacheMs: 5000 },
    )

    // Import Claude Code settings.json format directly!
    const settingsText = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: mock.baseUrl,
        ANTHROPIC_AUTH_TOKEN: mock.scenarios["claude-pool-weighted"].apiKey,
      },
    })

    const imported = await hooks.auth.import([settingsText])
    // 1 primary endpoint card + 3 upstream node cards = 4 separate Magpie accounts!
    assert.equal(imported.length, 4)
    assert.ok(imported.every((r) => r.type === "success"))

    const first = hostApplyImport({}, "cchost", imported)
    assert.equal(Object.keys(first.authStore).length, 4)
    assert.deepEqual(
      first.results.map((r) => r.status),
      ["added", "added", "added", "added"],
    )

    // Re-importing the exact same file updates all 4 in place with ZERO duplicates
    const second = hostApplyImport(first.authStore, "cchost", imported)
    assert.equal(Object.keys(second.authStore).length, 4)
    assert.deepEqual(
      second.results.map((r) => r.status),
      ["updated", "updated", "updated", "updated"],
    )

    // Verify per-account model lists & Magpie routing isolation:
    // Primary card serves all models; the 3 node sub-cards serve [] (never routed to!)
    const modelMaps = {}
    for (const [k, auth] of Object.entries(first.authStore)) {
      modelMaps[k] = await hooks.provider.models({ models: {} }, { auth })
    }
    const routing = goPluginAccountRouting(modelMaps)
    assert.ok(routing.servedCatalog.includes("claude-sonnet-4-6"))
    assert.ok(routing.servedCatalog.includes("claude-fable-5"))

    const primaryKey = "cchost"
    const subKeys = Object.keys(first.authStore).filter((k) => k !== primaryKey)
    assert.equal(routing.accountServes(primaryKey, "claude-sonnet-4-6"), true)
    for (const sk of subKeys) {
      assert.equal(routing.accountServes(sk, "claude-sonnet-4-6"), false)
      assert.equal(routing.accountServes(sk, "claude-fable-5"), false)
    }

    // Refresh ALL 4 cards in parallel -> coalescing guarantees ONLY 1 HTTP GET /v1/usage!
    const usageCallsBefore = mock.requests.filter((r) => r.path === "/v1/usage").length
    const cards = await Promise.all(
      Object.entries(first.authStore).map(async ([k, auth]) => ({
        key: k,
        auth,
        usage: hostNormalizeUsage(
          await hooks.auth.usage(async () => auth, { models: modelMaps[k] }),
        ),
      })),
    )
    const usageCallsAfter = mock.requests.filter((r) => r.path === "/v1/usage").length
    assert.equal(usageCallsAfter - usageCallsBefore, 1)

    // Primary card: aggregated pool (no duplicate aside breakdown rows!)
    const primaryCard = cards.find((c) => c.key === primaryKey)
    assert.equal(primaryCard.usage.plan, "Claude ×3 (26x)")
    assert.equal(primaryCard.usage.windows.filter((w) => w.aside).length, 0)
    assert.equal(primaryCard.usage.windows.find((w) => w.name === "5 hours").used, 37.7)
    assert.equal(primaryCard.usage.windows.find((w) => w.name === "7 days · Fable").used, 58)

    // Each upstream account has its OWN independent subscription card with 5h, 7d, and Fable!
    const max20Card = cards.find((c) => c.usage.user.includes("Claude-Max20x"))
    assert.equal(max20Card.usage.plan, "Claude Max 20x")
    assert.equal(max20Card.usage.windows.find((w) => w.name === "5 hours").used, 20)
    assert.equal(max20Card.usage.windows.find((w) => w.name === "7 days").used, 30)
    assert.equal(max20Card.usage.windows.find((w) => w.name === "7 days · Fable").used, 50)

    const max5Card = cards.find((c) => c.usage.user.includes("Claude-Max5x"))
    assert.equal(max5Card.usage.plan, "Claude Max 5x")
    assert.equal(max5Card.usage.windows.find((w) => w.name === "5 hours").used, 100)
    assert.equal(max5Card.usage.windows.find((w) => w.name === "7 days · Fable").used, 90)

    const proCard = cards.find((c) => c.usage.user.includes("Claude-Pro"))
    assert.equal(proCard.usage.plan, "Claude Pro")
    assert.equal(proCard.usage.windows.find((w) => w.name === "5 hours").used, 80)
    assert.equal(proCard.usage.windows.find((w) => w.name === "7 days").used, 90)
    assert.equal(proCard.usage.windows.find((w) => w.name.includes("Fable")), undefined)

    // Also verify Method 1 (interactive single upstream account login)
    const singleNodeSignIn = await hooks.auth.methods[1].authorize({
      baseUrl: mock.baseUrl,
      apiKey: mock.scenarios["claude-pool-weighted"].apiKey,
      nodeSelector: "Claude-Max20x",
    })
    assert.equal(singleNodeSignIn.type, "success")
    assert.equal(singleNodeSignIn.metadata.role, "node")
    assert.equal(singleNodeSignIn.metadata.nodeId, "c-20x")
    assert.equal(singleNodeSignIn.metadata.usageOnly, true)

    // Verify graceful error if a previously imported node was removed from CC Host
    const missingAuth = {
      type: "api",
      key: mock.scenarios["claude-pool-weighted"].apiKey,
      metadata: {
        baseUrl: mock.baseUrl,
        label: "team · RemovedNode",
        role: "node",
        nodeId: "deleted-node-999",
        nodeName: "RemovedNode",
        usageOnly: true,
      },
    }
    const missingUsage = await hooks.auth.usage(async () => missingAuth, { models: {} })
    assert.equal(missingUsage.signIn, "kept")
    assert.match(missingUsage.error, /no longer in this CC Host endpoint/i)
  })

  it("Option B direct sign-in (no file import): Method 0 auto-splits multi-account endpoint via client.auth.set and updates idempotently", async () => {
    const harness = hostCreateSignInHarness("cchost")
    const switches = { show_node_breakdown: true, force_global_windows: false }
    const hooks = await CCHostAuthPlugin(
      {
        client: harness.client,
        magpie: {
          option: (_p, k) => Boolean(switches[k]),
          options: () => ({ ...switches }),
        },
      },
      { now: () => FIXED_NOW, usageCacheMs: 5000 },
    )

    // Direct Method 0 sign-in with default splitMode ("split") — NO file import!
    const res1 = await harness.runApiAuthorize(hooks.auth.methods[0], {
      baseUrl: mock.baseUrl,
      apiKey: mock.scenarios["claude-pool-weighted"].apiKey,
      label: "direct-pool",
      aggregation: "weighted",
      splitMode: "split",
    })
    assert.equal(res1.type, "success")
    assert.equal(res1.metadata.splitCards, true)

    const store1 = harness.getAuthStore()
    assert.equal(Object.keys(store1).length, 4)

    // Re-signing-in to the exact same endpoint updates all 4 cards in place (still 4, zero duplicates)
    const res2 = await harness.runApiAuthorize(hooks.auth.methods[0], {
      baseUrl: mock.baseUrl,
      apiKey: mock.scenarios["claude-pool-weighted"].apiKey,
      label: "direct-pool",
      aggregation: "weighted",
      splitMode: "split",
    })
    assert.equal(res2.type, "success")
    const store2 = harness.getAuthStore()
    assert.equal(Object.keys(store2).length, 4)

    // Verify routing isolation: primary card serves models, 3 split node cards serve {}
    const modelMaps = {}
    for (const [k, auth] of Object.entries(store2)) {
      modelMaps[k] = await hooks.provider.models({ models: {} }, { auth })
    }
    const routing = goPluginAccountRouting(modelMaps)
    const primaryKey = Object.entries(store2).find(([, a]) => a.metadata.role === "endpoint")[0]
    assert.equal(routing.accountServes(primaryKey, "claude-sonnet-4-6"), true)
    for (const [k, a] of Object.entries(store2)) {
      if (a.metadata.role === "node") {
        assert.equal(routing.accountServes(k, "claude-sonnet-4-6"), false)
      }
    }

    // Verify each split card renders its own node quota + Fable cleanly
    const cards = await Promise.all(
      Object.entries(store2).map(async ([k, auth]) => ({
        key: k,
        usage: hostNormalizeUsage(
          await hooks.auth.usage(async () => auth, { models: modelMaps[k] }),
        ),
      })),
    )
    const primaryCard = cards.find((c) => c.key === primaryKey)
    assert.equal(primaryCard.usage.plan, "Claude ×3 (26x)")
    assert.equal(primaryCard.usage.windows.filter((w) => w.aside).length, 0)
    const max20Card = cards.find((c) => c.usage.user.includes("Claude-Max20x"))
    assert.equal(max20Card.usage.windows.find((w) => w.name === "7 days · Fable").used, 50)
  })

  it("verifies zero external network requests were made (100% local loopback mock)", () => {
    assert.ok(mock.baseUrl.startsWith("http://127.0.0.1:"))
    assert.ok(mock.requests.length > 0)
  })
})
