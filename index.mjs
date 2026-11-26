import {
  PROVIDER_ID,
  PROVIDER_NAME,
  defaultEndpointLabel,
  normalizeBaseUrl,
  resolveAccountConfig,
  validateBaseUrl,
} from "./lib/config.mjs"
import { parseCchostUsage } from "./lib/usage-parser.mjs"
import {
  aggregateCchostUsage,
  buildSingleNodeUsage,
} from "./lib/quota-aggregator.mjs"
import { buildModelsMap } from "./lib/models.mjs"
import { parseImportedEndpoints } from "./lib/import-parser.mjs"
import {
  createCchostFetch,
  createCoalescedUsageFetcher,
  fetchCchostModels,
  fetchCchostUsage,
} from "./lib/client.mjs"

const FALLBACK_MODELS = {
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    provider: { npm: "@ai-sdk/anthropic" },
    limit: { context: 200000, output: 64000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    provider: { npm: "@ai-sdk/anthropic" },
    limit: { context: 200000, output: 64000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  },
}

function stableNodeSlotKey(baseUrl, nodeId) {
  // Deterministic FNV-1a 64-bit hash so re-signing-in to the same endpoint
  // updates existing per-node cards in place instead of creating duplicates.
  const text = `${baseUrl}\0${nodeId}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
  }
  const suffix = `${h1.toString(36).padStart(7, "0")}${h2.toString(36).padStart(5, "0")}`.slice(0, 10)
  return `${PROVIDER_ID}#nd_${suffix}`
}

function buildNodeCardMetadataList(nodes, { baseUrl, endpointLabel, aggregation, usageOnly }) {
  const seenNames = new Map()
  return nodes.map((node) => {
    const baseNodeName = node.name || node.id
    const count = (seenNames.get(baseNodeName.toLowerCase()) ?? 0) + 1
    seenNames.set(baseNodeName.toLowerCase(), count)
    const uniqueNodeName =
      count > 1 ? `${baseNodeName} (${node.id.slice(-4)})` : baseNodeName
    const cardLabel = `${endpointLabel} · ${uniqueNodeName}`
    return {
      slotKey: stableNodeSlotKey(baseUrl, node.id),
      metadata: {
        baseUrl,
        label: cardLabel,
        email: cardLabel,
        aggregation,
        role: "node",
        nodeId: node.id,
        nodeName: node.name,
        accountType: node.accountType,
        usageOnly,
      },
    }
  })
}

function readOptionSwitches(input) {
  try {
    if (typeof input?.magpie?.options === "function") {
      return input.magpie.options(PROVIDER_ID) ?? {}
    }
  } catch {
    // older Magpie or OpenCode host without input.magpie.options
  }
  return {}
}

/**
 * OpenCode / Magpie Provider Plugin for CC Host (cchost.ai).
 *
 * Supports two display topologies for aggregated endpoints:
 * - Single endpoint card (via normal sign-in): aggregated pool windows on top +
 *   expanded per-account progress bars (`aside: true`) below.
 * - Multi-card split (via `auth.import` or single-node sign-in): 1 primary
 *   endpoint card (handles routing + aggregated quota) + N independent
 *   per-account subscription cards (each with its own 5h/7d/Fable/Opus bars
 *   and quota history curve, excluded from duplicate routing via empty models).
 *
 * Note: Only this plugin function is exported as a function; helpers are placed
 * on `_internal` per Magpie's module export rules.
 */
export const CCHostAuthPlugin = async (input, pluginOptions = {}) => {
  const fetchImpl = pluginOptions?.fetchImpl ?? globalThis.fetch
  const nowFn = typeof pluginOptions?.now === "function" ? pluginOptions.now : () => Date.now()
  const usageCacheMs =
    typeof pluginOptions?.usageCacheMs === "number" && pluginOptions.usageCacheMs >= 0
      ? pluginOptions.usageCacheMs
      : 3000
  const getUsageCoalesced = createCoalescedUsageFetcher({
    ttlMs: usageCacheMs,
    fetchImpl,
    now: nowFn,
  })

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/anthropic",
        api: "https://cchost.ai/v1",
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER_ID,
      importFrom:
        "CC Host endpoint JSON (baseUrl + apiKey, or Claude Code settings.json) — splits every upstream account into its own subscription card.",
      importFroms: {
        zh: "导入 CC Host 接入点 JSON（含 baseUrl 与 apiKey，或直接导入 Claude Code settings.json）—— 自动把接入点下的每个上游订阅账号拆成独立卡片。",
        "zh-TW":
          "匯入 CC Host 接入點 JSON（含 baseUrl 與 apiKey，或直接匯入 Claude Code settings.json）—— 自動將接入點下的每個上游訂閱帳號拆成獨立卡片。",
      },

      options: [
        {
          key: "show_node_breakdown",
          label: "Expand each upstream account's quota bars",
          labels: {
            zh: "单卡内散开显示各聚合账号进度条",
            "zh-TW": "單卡內展開顯示各聚合帳號進度條",
          },
          description:
            "On: on a single aggregated endpoint card, also show each upstream account's 5h/7d/Fable/Opus bars below the pool (display-only; auto-off on split primary cards).",
          descriptions: {
            zh: "开启：单卡模式下在总池下方展开每个上游账号的 5h/7d/Fable/Opus 进度条（仅展示不影响路由；使用多卡导入拆分的主卡默认保持简洁）。",
            "zh-TW": "開啟：單卡模式下於總池下方展開各上游帳號的 5h/7d/Fable/Opus 進度條（僅展示不影響路由；多卡拆分的主卡預設保持精簡）。",
          },
          default: true,
        },
        {
          key: "force_global_windows",
          label: "Merge all account types into one 5h/7d view",
          labels: {
            zh: "合并异构账号类型为统一 5h/7d 窗口",
            "zh-TW": "合併異構帳號類型為統一 5h/7d 視窗",
          },
          description:
            "Off (recommended): heterogeneous endpoints (e.g. Claude + Codex) expose separate model-scoped 5h/7d pools so one full pool never blocks another. On: merge all subscription nodes into global 5h/7d windows.",
          descriptions: {
            zh: "关闭（推荐）：混合了 Claude + Codex 等多种账号的接入点按类型拆分模型级 5h/7d 额度池，互不阻塞；开启：合并为全局 5h/7d 窗口。",
            "zh-TW": "關閉（推薦）：混合多種帳號的接入點按類型拆分模型級 5h/7d 額度池，互不阻塞；開啟：合併為全域 5h/7d 視窗。",
          },
          default: false,
        },
      ],

      /**
       * Batch-import a CC Host endpoint and split all of its upstream accounts
       * (`GET /v1/usage` -> `nodes[]`) into separate Magpie subscription cards:
       * - 1 primary endpoint card (serves models + aggregated pool quota for routing)
       * - N per-node cards (each displays 1 upstream account's own 5h/7d/Fable/Opus
       *   bars & quota curve, with `usageOnly: true` so Magpie never routes duplicate
       *   retries to them).
       */
      async import(texts, { signal } = {}) {
        const specs = parseImportedEndpoints(texts)
        if (specs.length === 0) {
          return [
            {
              type: "failed",
              error:
                'No CC Host endpoint found in file. Expected JSON like {"baseUrl":"https://...","apiKey":"cchost_...","label":"my-ep"} or Claude Code settings.json.',
            },
          ]
        }

        const results = []
        for (const spec of specs) {
          if (!spec.baseUrl || !spec.apiKey) {
            results.push({
              type: "failed",
              error: `Incomplete endpoint entry (${spec.label || spec.baseUrl || "unnamed"}): both baseUrl and apiKey are required`,
            })
            continue
          }

          let rawUsage
          try {
            rawUsage = await fetchCchostUsage(spec.baseUrl, spec.apiKey, {
              signal,
              timeoutMs: pluginOptions?.requestTimeoutMs ?? 15000,
              fetchImpl,
            })
          } catch (err) {
            results.push({
              type: "failed",
              error: err?.message || `Failed to query ${spec.baseUrl}/v1/usage`,
            })
            continue
          }

          const parsed = parseCchostUsage(rawUsage, {
            now: nowFn(),
            utilizationScale: pluginOptions?.utilizationScale ?? "auto",
            nodeWeights: pluginOptions?.nodeWeights,
            tierWeights: pluginOptions?.tierWeights,
          })

          const endpointLabel =
            spec.label || parsed.endpointName || defaultEndpointLabel(spec.baseUrl)

          const nodes = parsed.nodes.filter(
            (n) => spec.includeOfflineNodes || n.status !== "unavailable",
          )

          // 1. Primary endpoint card (placed first so it becomes the active routing seat)
          if (spec.includeEndpointCard || nodes.length === 0) {
            results.push({
              type: "success",
              key: spec.apiKey,
              metadata: {
                baseUrl: spec.baseUrl,
                label: endpointLabel,
                email: endpointLabel,
                aggregation: spec.aggregation,
                role: "endpoint",
                splitCards: nodes.length > 1,
                usageOnly: false,
              },
            })
          }

          // 2. One independent subscription card per upstream node (when >1 node, or when
          //    includeEndpointCard is false so user wants node cards only)
          if (nodes.length > 1 || !spec.includeEndpointCard) {
            const nodeCards = buildNodeCardMetadataList(nodes, {
              baseUrl: spec.baseUrl,
              endpointLabel,
              aggregation: spec.aggregation,
              usageOnly: spec.includeEndpointCard,
            })
            for (const card of nodeCards) {
              results.push({
                type: "success",
                key: spec.apiKey,
                metadata: card.metadata,
              })
            }
          }
        }

        return results
      },

      methods: [
        {
          type: "api",
          label: "CC Host Endpoint (Base URL + API Key)",
          labels: {
            zh: "CC Host 接入点（Base URL + API Key）",
            "zh-TW": "CC Host 接入點（Base URL + API Key）",
          },
          prompts: [
            {
              type: "text",
              key: "baseUrl",
              message: "CC Host endpoint Base URL",
              messages: {
                zh: "CC Host 接入点 Base URL",
                "zh-TW": "CC Host 接入點 Base URL",
              },
              placeholder: "https://api.cchost.ai/e/your-endpoint",
              validate: validateBaseUrl,
            },
            {
              type: "password",
              key: "apiKey",
              message: "CC Host endpoint API Key",
              messages: {
                zh: "CC Host 接入点 API Key",
                "zh-TW": "CC Host 接入點 API Key",
              },
              placeholder: "cchost_...",
              validate: (v) =>
                typeof v === "string" && v.trim().length > 0
                  ? undefined
                  : "API Key is required",
            },
            {
              type: "text",
              key: "label",
              message: "Subscription label (optional, differentiates multiple endpoints)",
              messages: {
                zh: "订阅名称（可选，用于区分多个接入点）",
                "zh-TW": "訂閱名稱（可選，用於區分多個接入點）",
              },
              placeholder: "e.g. prod-claude",
            },
            {
              type: "select",
              key: "aggregation",
              message: "Multi-account quota aggregation strategy",
              messages: {
                zh: "多订阅聚合额度计算策略",
                "zh-TW": "多訂閱聚合額度計算策略",
              },
              options: [
                {
                  label: "Capacity-weighted pool (Recommended)",
                  value: "weighted",
                  hint: "Weights accounts by plan tier (20x/5x/1x) with 5h/7d bottleneck coupling",
                  labels: { zh: "按套餐容量加权池化（推荐）" },
                  hints: { zh: "按 20x/5x/1x 套餐权重加权，并自动扣除因 7d 用满而不可用的 5h 额度" },
                },
                {
                  label: "Best available node (min used)",
                  value: "min_used",
                  hint: "Tracks the freest usable node; reaches 100% only when all nodes are blocked",
                  labels: { zh: "最空闲可用节点（最小值）" },
                  hints: { zh: "取当前最空闲节点的占用率，仅当所有节点全部受限时才满额" },
                },
                {
                  label: "Conservative / earliest warning (max used)",
                  value: "max_used",
                  hint: "Matches CC Host summary.maxUtilization; warns as soon as any node fills",
                  labels: { zh: "保守预警（最大值，等同 maxUtilization）" },
                  hints: { zh: "任一节点额度拉满即告警，适合作为早期阈值信号" },
                },
                {
                  label: "Equal-weight average",
                  value: "average",
                  hint: "Simple arithmetic mean across active nodes",
                  labels: { zh: "等权平均" },
                  hints: { zh: "所有活跃节点按相同权重求均值" },
                },
              ],
            },
            {
              type: "select",
              key: "splitMode",
              message: "Multi-account card layout",
              messages: {
                zh: "多账号展示方式",
                "zh-TW": "多帳號顯示方式",
              },
              options: [
                {
                  label: "Auto-split each upstream account into its own card (Recommended)",
                  value: "split",
                  hint: "Creates 1 routing card + 1 independent quota card per upstream node directly (no file import needed)",
                  labels: { zh: "自动拆成多张独立卡片（推荐，无需导入文件）" },
                  hints: { zh: "1 张主卡负责路由 + 接入点下每个上游账号各自 1 张独立额度卡片" },
                },
                {
                  label: "Single combined endpoint card",
                  value: "single",
                  hint: "Keep 1 card for the whole endpoint (expand per-node bars inside Usage)",
                  labels: { zh: "合并为单张接入点卡片" },
                  hints: { zh: "只保留 1 张汇总卡（可在 Usage 页下方展开节点进度条）" },
                },
              ],
            },
          ],

          async authorize(inputs = {}, { signal } = {}) {
            const baseUrl = normalizeBaseUrl(inputs.baseUrl)
            if (!baseUrl) {
              return { type: "failed", error: "Invalid CC Host endpoint Base URL" }
            }
            const apiKey = typeof inputs.apiKey === "string" ? inputs.apiKey.trim() : ""
            if (!apiKey) {
              return { type: "failed", error: "API Key is required" }
            }
            const aggregation = inputs.aggregation || "weighted"
            const splitMode = inputs.splitMode === "single" ? "single" : "split"

            let parsedUsage = null
            try {
              const usagePayload = await fetchCchostUsage(baseUrl, apiKey, {
                signal,
                timeoutMs: pluginOptions?.requestTimeoutMs ?? 15000,
                fetchImpl,
              })
              parsedUsage = parseCchostUsage(usagePayload, {
                now: nowFn(),
                utilizationScale: pluginOptions?.utilizationScale ?? "auto",
                nodeWeights: pluginOptions?.nodeWeights,
                tierWeights: pluginOptions?.tierWeights,
              })
            } catch (err) {
              if (err?.status === 401) {
                return {
                  type: "failed",
                  error: err.message || "Invalid CC Host API Key (401)",
                }
              }
              try {
                await fetchCchostModels(baseUrl, apiKey, {
                  signal,
                  timeoutMs: pluginOptions?.requestTimeoutMs ?? 15000,
                  fetchImpl,
                })
              } catch (modelsErr) {
                return {
                  type: "failed",
                  error: modelsErr?.message || err?.message || "Could not reach CC Host endpoint",
                }
              }
            }

            const label =
              (typeof inputs.label === "string" && inputs.label.trim()) ||
              parsedUsage?.endpointName ||
              defaultEndpointLabel(baseUrl)

            // When signing in directly (no file import needed), if the endpoint has >1
            // upstream nodes and `splitMode === "split"`, save each upstream node as an
            // independent usage-only Magpie card via `input.client.auth.set`.
            let didSplit = false
            const nodes = parsedUsage?.nodes ?? []
            if (
              splitMode === "split" &&
              nodes.length > 1 &&
              typeof input?.client?.auth?.set === "function"
            ) {
              const nodeCards = buildNodeCardMetadataList(nodes, {
                baseUrl,
                endpointLabel: label,
                aggregation,
                usageOnly: true,
              })
              let written = 0
              for (const card of nodeCards) {
                try {
                  await input.client.auth.set({
                    path: { id: card.slotKey },
                    body: {
                      type: "api",
                      key: apiKey,
                      metadata: card.metadata,
                    },
                  })
                  written++
                } catch {
                  // Ignore if running in a minimal host without multi-slot auth.set
                }
              }
              didSplit = written === nodeCards.length
            }

            return {
              type: "success",
              key: apiKey,
              metadata: {
                baseUrl,
                label,
                email: label,
                aggregation,
                role: "endpoint",
                splitCards: didSplit,
                usageOnly: false,
              },
            }
          },
        },
        {
          type: "api",
          label: "CC Host Single Upstream Account (Separate Card)",
          labels: {
            zh: "CC Host 单个上游账号（独立额度卡片）",
            "zh-TW": "CC Host 單一上游帳號（獨立額度卡片）",
          },
          prompts: [
            {
              type: "text",
              key: "baseUrl",
              message: "CC Host endpoint Base URL",
              messages: {
                zh: "CC Host 接入点 Base URL",
                "zh-TW": "CC Host 接入點 Base URL",
              },
              placeholder: "https://api.cchost.ai/e/your-endpoint",
              validate: validateBaseUrl,
            },
            {
              type: "password",
              key: "apiKey",
              message: "CC Host endpoint API Key",
              messages: {
                zh: "CC Host 接入点 API Key",
                "zh-TW": "CC Host 接入點 API Key",
              },
              placeholder: "cchost_...",
              validate: (v) =>
                typeof v === "string" && v.trim().length > 0
                  ? undefined
                  : "API Key is required",
            },
            {
              type: "text",
              key: "nodeSelector",
              message: "Upstream account ID or name (from /v1/usage nodes[])",
              messages: {
                zh: "上游账号 ID 或名称（对应 /v1/usage 中的节点）",
                "zh-TW": "上游帳號 ID 或名稱（對應 /v1/usage 中的節點）",
              },
              placeholder: "e.g. Claude-Max20x or node-claude-1",
              validate: (v) =>
                typeof v === "string" && v.trim().length > 0
                  ? undefined
                  : "Account ID or name is required",
            },
            {
              type: "text",
              key: "label",
              message: "Card label (optional)",
              messages: {
                zh: "卡片名称（可选）",
                "zh-TW": "卡片名稱（可選）",
              },
              placeholder: "e.g. team-claude · Max20x",
            },
          ],

          async authorize(inputs = {}, { signal } = {}) {
            const baseUrl = normalizeBaseUrl(inputs.baseUrl)
            if (!baseUrl) {
              return { type: "failed", error: "Invalid CC Host endpoint Base URL" }
            }
            const apiKey = typeof inputs.apiKey === "string" ? inputs.apiKey.trim() : ""
            if (!apiKey) {
              return { type: "failed", error: "API Key is required" }
            }
            const selector = String(inputs.nodeSelector ?? "").trim()
            if (!selector) {
              return { type: "failed", error: "Upstream account ID or name is required" }
            }

            let rawUsage
            try {
              rawUsage = await fetchCchostUsage(baseUrl, apiKey, {
                signal,
                timeoutMs: pluginOptions?.requestTimeoutMs ?? 15000,
                fetchImpl,
              })
            } catch (err) {
              return {
                type: "failed",
                error: err?.message || "Could not fetch /v1/usage from CC Host endpoint",
              }
            }

            const parsed = parseCchostUsage(rawUsage, { now: nowFn() })
            const lower = selector.toLowerCase()
            const matched =
              parsed.nodes.find((n) => n.id === selector) ||
              parsed.nodes.find((n) => (n.name || "").toLowerCase() === lower) ||
              parsed.nodes.find((n) => (n.name || "").toLowerCase().includes(lower))

            if (!matched) {
              const available = parsed.nodes.map((n) => `${n.name} (${n.id})`).join(", ")
              return {
                type: "failed",
                error: `Account "${selector}" not found in /v1/usage. Available: ${available || "none"}`,
              }
            }

            const epLabel = parsed.endpointName || defaultEndpointLabel(baseUrl)
            const cardLabel =
              (typeof inputs.label === "string" && inputs.label.trim()) ||
              `${epLabel} · ${matched.name}`

            return {
              type: "success",
              key: apiKey,
              metadata: {
                baseUrl,
                label: cardLabel,
                email: cardLabel,
                role: "node",
                nodeId: matched.id,
                nodeName: matched.name,
                accountType: matched.accountType,
                usageOnly: true,
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        const cfg = resolveAccountConfig(auth, pluginOptions, readOptionSwitches(input))
        if (!cfg.baseUrl || !cfg.apiKey) return {}
        return {
          baseURL: `${cfg.baseUrl}/v1`,
          apiKey: cfg.apiKey,
          fetch: createCchostFetch(getAuth, pluginOptions, fetchImpl),
        }
      },

      async usage(getAuth, provider, { signal } = {}) {
        const auth = await getAuth()
        if (auth?.type !== "api") {
          return { error: "Not signed in to a CC Host endpoint", windows: [] }
        }
        const switches = readOptionSwitches(input)
        const cfg = resolveAccountConfig(auth, pluginOptions, switches)
        if (!cfg.baseUrl) {
          return {
            user: cfg.label,
            error: "Missing CC Host endpoint Base URL — sign in again",
            windows: [],
            signIn: "kept",
          }
        }

        try {
          const rawUsage = await getUsageCoalesced(cfg.baseUrl, cfg.apiKey, {
            signal,
            shared: cfg.role === "node" || cfg.splitCards,
            timeoutMs: cfg.requestTimeoutMs,
            fetchImpl,
          })
          const now = nowFn()
          const parsed = parseCchostUsage(rawUsage, {
            now,
            utilizationScale: cfg.utilizationScale,
            nodeWeights: cfg.nodeWeights,
            tierWeights: cfg.tierWeights,
          })

          if (cfg.role === "node") {
            return buildSingleNodeUsage(parsed, {
              nodeId: cfg.nodeId,
              nodeName: cfg.nodeName,
              now,
              label: cfg.label,
              crossWindowCoupling: false,
            })
          }

          const catalogModels = Object.keys(provider?.models ?? {})
          return aggregateCchostUsage(parsed, {
            now,
            aggregation: cfg.aggregation,
            crossWindowCoupling: cfg.crossWindowCoupling,
            showNodeBreakdown: cfg.showNodeBreakdown,
            forceGlobalWindows: cfg.forceGlobalWindows,
            includePaygNote: cfg.includePaygNote,
            catalogModels,
            label: cfg.label,
          })
        } catch (err) {
          return {
            user: cfg.label,
            error: err?.message ?? String(err),
            windows: [],
            signIn: err?.signIn ?? "kept",
          }
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== "api") return provider.models
        const cfg = resolveAccountConfig(auth, pluginOptions, readOptionSwitches(input))
        if (!cfg.baseUrl || !cfg.apiKey) return provider.models

        // Usage-only per-node cards deliberately expose an empty (non-fellBack)
        // model map so Magpie's `pluginLists(model)` excludes them from routing
        // and failover retries while still showing their independent Usage cards.
        if (cfg.usageOnly) {
          return {}
        }

        const rawModels = await fetchCchostModels(cfg.baseUrl, cfg.apiKey, {
          signal,
          timeoutMs: cfg.requestTimeoutMs,
          fetchImpl,
        })
        const mapped = buildModelsMap(rawModels, cfg.baseUrl)
        if (Object.keys(mapped).length === 0) {
          const fell = { ...provider.models }
          fell[Symbol.for("magpie.fellBack")] = true
          return fell
        }
        return mapped
      },
    },
  }
}

export const _internal = {
  PROVIDER_ID,
  PROVIDER_NAME,
  normalizeBaseUrl,
  validateBaseUrl,
  resolveAccountConfig,
  parseCchostUsage,
  aggregateCchostUsage,
  buildSingleNodeUsage,
  buildModelsMap,
  parseImportedEndpoints,
  fetchCchostUsage,
  fetchCchostModels,
  createCoalescedUsageFetcher,
  createCchostFetch,
}
