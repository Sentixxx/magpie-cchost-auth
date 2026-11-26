import http from "node:http"
import { fileURLToPath } from "node:url"

/**
 * Local-only CC Host mock server (strictly binds to 127.0.0.1).
 *
 * Implements CC Host inference & observability endpoints documented at:
 * https://cchost.ai/docs/api & https://cchost.ai/docs/usage
 *   - GET  /v1/models
 *   - GET  /v1/usage
 *   - POST /v1/messages
 *   - POST /v1/messages/count_tokens
 *   - POST /v1/responses
 *   - POST /v1/chat/completions
 */
export function buildMockScenarios(now = Date.now()) {
  const h = (hrs) => new Date(now + hrs * 3600_000).toISOString()
  const d = (days) => new Date(now + days * 86400_000).toISOString()

  return {
    // 1. Single Claude Max 20x subscription (includes Opus + Fable weekly_scoped windows)
    "single-claude": {
      apiKey: "cchost_mock_single_claude",
      models: [
        { id: "claude-sonnet-4-6", owned_by: "claude", display_name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-6", owned_by: "claude", display_name: "Claude Opus 4.6" },
        { id: "claude-fable-5-1", owned_by: "claude", display_name: "Claude Fable 5.1" },
        { id: "claude-haiku-4-5", owned_by: "claude", display_name: "Claude Haiku 4.5" },
      ],
      usage: {
        endpoint: { name: "single-claude", routingStrategy: "random" },
        summary: { maxUtilization: 0.42 },
        snapshotAt: new Date(now - 30_000).toISOString(),
        nodes: [
          {
            id: "node-claude-1",
            name: "Claude Main",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            snapshotAt: new Date(now - 30_000).toISOString(),
            windows: {
              five_hour: { utilization: 0.42, resets_at: h(2.5) },
              seven_day: { utilization: 0.31, resets_at: d(4) },
              seven_day_opus: { utilization: 0.55, resets_at: d(4) },
              seven_day_overage_included: { utilization: 0.64, resets_at: d(4) },
            },
            resets: { count: 2, fiveHour: 1, weekly: 1, byWindow: true, until: d(10) },
          },
        ],
      },
    },

    // 2. Homogeneous multi-subscription aggregation: 20x + 5x + 1x Claude accounts (Max accounts have Fable)
    "claude-pool-weighted": {
      apiKey: "cchost_mock_claude_pool",
      models: [
        { id: "claude-sonnet-4-6", owned_by: "claude" },
        { id: "claude-opus-4-6", owned_by: "claude" },
        { id: "claude-fable-5", owned_by: "claude" },
      ],
      usage: {
        endpoint: { name: "claude-team-pool", routingStrategy: "load_balance" },
        summary: { maxUtilization: 100 },
        snapshotAt: new Date(now - 15_000).toISOString(),
        nodes: [
          {
            id: "c-20x",
            name: "Claude-Max20x",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            windows: [
              { key: "five_hour", utilization: 20, resetsAt: h(4), span: 18000 },
              { key: "seven_day", utilization: 30, resetsAt: d(5), span: 604800 },
              { key: "sevenDayFable", utilization: 50, resetsAt: d(5), span: 604800 },
            ],
          },
          {
            id: "c-5x",
            name: "Claude-Max5x",
            accountType: "claude",
            plan: "Max 5x",
            status: "quota_exhausted",
            windows: [
              { key: "five_hour", utilization: 100, resetsAt: h(1), span: 18000 },
              { key: "seven_day", utilization: 60, resetsAt: d(2), span: 604800 },
              { key: "sevenDayFable", utilization: 90, resetsAt: d(2), span: 604800 },
            ],
          },
          {
            id: "c-1x",
            name: "Claude-Pro",
            accountType: "claude",
            plan: "Pro",
            status: "ready",
            windows: [
              { key: "five_hour", utilization: 80, resetsAt: h(3), span: 18000 },
              { key: "seven_day", utilization: 90, resetsAt: d(1), span: 604800 },
            ],
          },
        ],
      },
    },

    // 3. Cross-window bottleneck deadlock: Node A blocked on 7d (5h=10%), Node B blocked on 5h (7d=20%)
    // Naive average would wrongly report ~55% usable when ZERO nodes can serve requests!
    "cross-window-deadlock": {
      apiKey: "cchost_mock_deadlock",
      models: [{ id: "claude-sonnet-4-6", owned_by: "claude" }],
      usage: {
        endpoint: { name: "deadlocked-pool", routingStrategy: "random" },
        summary: { maxUtilization: 100 },
        nodes: [
          {
            id: "node-a",
            name: "Node A (7d full)",
            accountType: "claude",
            plan: "Pro",
            status: "quota_exhausted",
            windows: {
              five_hour: { utilization: 10, resetsAt: h(4) },
              seven_day: { utilization: 100, resetsAt: d(2) },
            },
          },
          {
            id: "node-b",
            name: "Node B (5h full)",
            accountType: "claude",
            plan: "Pro",
            status: "quota_exhausted",
            windows: {
              five_hour: { utilization: 100, resetsAt: h(1.5) },
              seven_day: { utilization: 20, resetsAt: d(5) },
            },
          },
        ],
      },
    },

    // 4. Heterogeneous endpoint: Claude (full) + Codex (healthy) + Gemini (healthy, overlapping claude-sonnet-4-6) + AI Studio (PAYG)
    "heterogeneous-multi-vendor": {
      apiKey: "cchost_mock_hetero",
      models: [
        { id: "claude-opus-4-6", owned_by: "claude" },
        { id: "claude-sonnet-4-6", owned_by: "claude" },
        { id: "gpt-5.4", owned_by: "codex" },
        { id: "gemini-2.5-pro", owned_by: "gemini" },
        { id: "aistudio/gemini-2.5-flash", owned_by: "aistudio" },
      ],
      usage: {
        endpoint: { name: "all-in-one", routingStrategy: "random" },
        summary: { maxUtilization: 100 },
        nodes: [
          {
            id: "cl-1",
            name: "Claude-1",
            accountType: "claude",
            plan: "Max 5x",
            status: "quota_exhausted",
            models: ["claude-opus-4-6", "claude-sonnet-4-6"],
            windows: {
              five_hour: { utilization: 100, resetsAt: h(2) },
              seven_day: { utilization: 85, resetsAt: d(3) },
            },
          },
          {
            id: "cx-1",
            name: "Codex-Pro",
            accountType: "codex",
            plan: "Pro",
            status: "ready",
            models: ["gpt-5.4"],
            windows: {
              five_hour: { utilization: 12, resetsAt: h(4) },
              seven_day: { utilization: 25, resetsAt: d(6) },
            },
          },
          {
            id: "gm-1",
            name: "Gemini-Pro",
            accountType: "gemini",
            plan: "Pro",
            status: "ready",
            models: ["gemini-2.5-pro", "claude-sonnet-4-6"],
            windows: {
              five_hour: { utilization: 20, resetsAt: h(3) },
              seven_day: { utilization: 15, resetsAt: d(5) },
            },
          },
          {
            id: "as-1",
            name: "AI-Studio-Key",
            accountType: "aistudio",
            status: "ready",
            models: ["aistudio/gemini-2.5-flash"],
            windows: [],
          },
        ],
      },
    },

    // 5. Shared account group + personal account + 1 offline self-hosted node
    "shared-group-and-offline": {
      apiKey: "cchost_mock_shared_group",
      models: [{ id: "claude-sonnet-4-6", owned_by: "claude" }],
      usage: {
        endpoint: { name: "shared-plus-own", routingStrategy: "priority" },
        summary: { maxUtilization: 75 },
        nodes: [
          {
            id: "grp-shared-1",
            name: "Team Shared Claude Group",
            accountType: "claude",
            isGroup: true,
            readyCount: 6,
            totalCount: 8,
            status: "ready",
            windows: {
              five_hour: { utilization: 75, resetsAt: h(1.5) },
              seven_day: { utilization: 50, resetsAt: d(3) },
            },
          },
          {
            id: "own-1",
            name: "My Own Claude",
            accountType: "claude",
            plan: "Pro",
            status: "ready",
            windows: {
              five_hour: { utilization: 10, resetsAt: h(4) },
              seven_day: { utilization: 20, resetsAt: d(6) },
            },
          },
          {
            id: "self-hosted-laptop",
            name: "MacBook Claude",
            accountType: "claude_self_hosted",
            plan: "Pro",
            status: "offline",
            windows: {
              five_hour: { utilization: 0, resetsAt: h(5) },
              seven_day: { utilization: 0, resetsAt: d(7) },
            },
          },
        ],
      },
    },

    // 6. All nodes offline -> 502 [cchost] No healthy nodes on inference
    "all-offline": {
      apiKey: "cchost_mock_offline",
      models: [],
      usage: {
        endpoint: { name: "offline-ep" },
        nodes: [
          { id: "off-1", name: "Laptop 1", accountType: "claude", status: "offline", windows: {} },
          { id: "off-2", name: "Laptop 2", accountType: "claude", status: "needs_login", windows: {} },
        ],
      },
    },
  }
}

export async function startMockCchostServer({ port = 0, now = () => Date.now(), scenarios } = {}) {
  const store = scenarios ?? buildMockScenarios(now())
  const byKey = new Map()
  for (const [name, sc] of Object.entries(store)) {
    byKey.set(sc.apiKey, { name, ...sc })
  }

  const requests = []

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString("utf8")

    const authHeader = req.headers["authorization"] ?? ""
    const xApiKey = req.headers["x-api-key"] ?? ""
    const hasBothAuth = Boolean(authHeader && xApiKey)
    const key =
      (typeof xApiKey === "string" && xApiKey.trim()) ||
      (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : "")

    requests.push({
      method: req.method,
      path: url.pathname,
      headers: { ...req.headers },
      hasBothAuth,
      body: rawBody,
    })

    const scenario = byKey.get(key)
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (!scenario) {
      if (url.pathname.startsWith("/v1/messages")) {
        return json(401, {
          type: "error",
          error: { type: "authentication_error", message: "[cchost] Invalid API key" },
        })
      }
      return json(401, {
        error: { type: "invalid_request_error", code: "invalid_api_key", message: "[cchost] Invalid API key" },
      })
    }

    if (req.method === "GET" && url.pathname === "/v1/usage") {
      if (scenario.usageStatus && scenario.usageStatus !== 200) {
        return json(scenario.usageStatus, scenario.usageError ?? { error: { message: "mock error" } })
      }
      const payload = typeof scenario.usage === "function" ? scenario.usage() : scenario.usage
      return json(200, payload)
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(200, { object: "list", data: scenario.models ?? [] })
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      return json(200, { input_tokens: 42 })
    }

    if (scenario.name === "all-offline") {
      if (url.pathname.startsWith("/v1/messages")) {
        return json(502, {
          type: "error",
          error: { type: "api_error", message: "[cchost] No healthy nodes" },
        })
      }
      return json(502, {
        error: { type: "server_error", code: "upstream_error", message: "[cchost] No healthy nodes" },
      })
    }

    let parsedBody = {}
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      return json(400, { error: { message: "Invalid JSON" } })
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return json(200, {
        id: "msg_mock_1",
        type: "message",
        role: "assistant",
        model: parsedBody.model ?? "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello from local CC Host mock (Anthropic Messages)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 8 },
      })
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      return json(200, {
        id: "resp_mock_1",
        object: "response",
        model: parsedBody.model ?? "gpt-5.4",
        status: "completed",
        output: [
          {
            id: "out_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hello from local CC Host mock (Responses)" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 },
      })
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return json(200, {
        id: "chatcmpl_mock_1",
        object: "chat.completion",
        model: parsedBody.model ?? "grok-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello from local CC Host mock (Chat)" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      })
    }

    return json(404, { error: { message: `Not found: ${url.pathname}` } })
  })

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    server,
    baseUrl,
    port: address.port,
    scenarios: store,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Allow running directly as a standalone local mock server: `node mock/cchost-mock-server.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 18787)
  const mock = await startMockCchostServer({ port })
  console.log(`CC Host local mock server listening on ${mock.baseUrl} (127.0.0.1 only)`)
  console.log("Available mock endpoint keys:")
  for (const [name, sc] of Object.entries(mock.scenarios)) {
    console.log(`  - ${name.padEnd(28)} x-api-key: ${sc.apiKey}`)
  }
}
