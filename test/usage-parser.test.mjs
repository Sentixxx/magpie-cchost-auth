import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseCchostUsage, detectUtilizationScale } from "../lib/usage-parser.mjs"
import { normalizeBaseUrl, inferTierWeight } from "../lib/config.mjs"

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const inHours = (h) => new Date(NOW + h * 3600_000).toISOString()
const inDays = (d) => new Date(NOW + d * 86400_000).toISOString()

describe("config helpers", () => {
  it("normalizes Base URLs with or without trailing slash or /v1", () => {
    assert.equal(normalizeBaseUrl("https://api.cchost.ai/e/abc/"), "https://api.cchost.ai/e/abc")
    assert.equal(normalizeBaseUrl("https://api.cchost.ai/e/abc/v1"), "https://api.cchost.ai/e/abc")
    assert.equal(normalizeBaseUrl("https://api.cchost.ai/e/abc/v1/"), "https://api.cchost.ai/e/abc")
    assert.equal(normalizeBaseUrl("http://127.0.0.1:18787/v1"), "http://127.0.0.1:18787")
    assert.equal(normalizeBaseUrl("ftp://bad.example"), "")
    assert.equal(normalizeBaseUrl("not-a-url"), "")
  })

  it("infers plan tier capacity weights accurately", () => {
    assert.equal(inferTierWeight("claude", "Max 20x"), 20)
    assert.equal(inferTierWeight("claude", "Max (5x)"), 5)
    assert.equal(inferTierWeight("claude", "Pro"), 1)
    assert.equal(inferTierWeight("codex", "Pro"), 10)
    assert.equal(inferTierWeight("codex", "Plus"), 1)
    assert.equal(inferTierWeight("claude", "Max 20x", { "claude:max_20x": 25 }), 25)
  })
})

describe("parseCchostUsage", () => {
  it("auto-detects 0..1 ratio scale and converts to 0..100 percentages", () => {
    const parsed = parseCchostUsage(
      {
        summary: { maxUtilization: 0.65 },
        nodes: [
          {
            id: "n1",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            windows: {
              five_hour: { utilization: 0.42, resets_at: inHours(2) },
              seven_day: { utilization: 0.65, resets_at: inDays(3) },
            },
          },
        ],
      },
      { now: NOW },
    )

    assert.equal(parsed.scale, "ratio")
    assert.equal(parsed.summaryMaxUtilization, 65)
    assert.equal(parsed.nodes.length, 1)
    assert.equal(parsed.nodes[0].weight, 20)
    assert.equal(parsed.nodes[0].windows.find((w) => w.kind === "five_hour").used, 42)
    assert.equal(parsed.nodes[0].windows.find((w) => w.kind === "seven_day").used, 65)
  })

  it("auto-detects 0..100 percent scale and preserves values", () => {
    const parsed = parseCchostUsage(
      {
        summary: { maxUtilization: 88 },
        nodes: [
          {
            id: "n1",
            type: "codex",
            tier: "Pro",
            status: "ready",
            windows: [
              { key: "5h", utilization: 35, resetsAt: inHours(3) },
              { key: "7d", utilization: 88, resetsAt: inDays(4) },
            ],
          },
        ],
      },
      { now: NOW },
    )

    assert.equal(parsed.scale, "percent")
    assert.equal(parsed.nodes[0].accountType, "codex")
    assert.equal(parsed.nodes[0].weight, 10)
    assert.equal(parsed.nodes[0].windows[0].kind, "five_hour")
    assert.equal(parsed.nodes[0].windows[0].used, 35)
    assert.equal(parsed.nodes[0].windows[1].kind, "seven_day")
    assert.equal(parsed.nodes[0].windows[1].used, 88)
  })

  it("handles exhausted node with ratio=1 unambiguously as 100%", () => {
    const scale = detectUtilizationScale(
      { summary: { maxUtilization: 1 } },
      [{ nodeStatus: "quota_exhausted", reading: { value: 1, ambiguous: true } }],
      "auto",
    )
    assert.equal(scale, "ratio")
  })

  it("resets expired window snapshots back to 0% when resetsAt <= now", () => {
    const parsed = parseCchostUsage(
      {
        nodes: [
          {
            id: "stale-node",
            accountType: "claude",
            status: "quota_exhausted",
            windows: {
              five_hour: { utilization: 100, resetsAt: new Date(NOW - 60_000).toISOString() },
              seven_day: { utilization: 40, resetsAt: inDays(2) },
            },
          },
        ],
      },
      { now: NOW },
    )

    const node = parsed.nodes[0]
    assert.equal(node.status, "ready")
    const w5 = node.windows.find((w) => w.kind === "five_hour")
    assert.equal(w5.expired, true)
    assert.equal(w5.used, 0)
    assert.equal(w5.resetsAt, null)
    const w7 = node.windows.find((w) => w.kind === "seven_day")
    assert.equal(w7.expired, false)
    assert.equal(w7.used, 40)
  })

  it("parses shared group member counts into capacity weights when explicit weight absent", () => {
    const parsed = parseCchostUsage(
      {
        nodes: [
          {
            id: "grp-1",
            name: "Shared Claude Group",
            accountType: "claude",
            isGroup: true,
            readyCount: 5,
            totalCount: 8,
            status: "ready",
            windows: {
              five_hour: { utilization: 60, resetsAt: inHours(1) },
              seven_day: { utilization: 50, resetsAt: inDays(3) },
            },
          },
        ],
      },
      { now: NOW },
    )

    assert.equal(parsed.nodes[0].isGroup, true)
    assert.equal(parsed.nodes[0].weight, 8)
    assert.equal(parsed.nodes[0].weightSource, "group_count")
  })

  it("supports explicit remainingPercent and amount/limit windows (e.g. Ollama monthly)", () => {
    const parsed = parseCchostUsage(
      {
        nodes: [
          {
            id: "ol-1",
            accountType: "ollama",
            status: "ready",
            windows: [
              { key: "monthly", amount: 36, limit: 60, unit: "USD", resetsAt: inDays(12) },
            ],
          },
          {
            id: "rem-1",
            accountType: "kimi",
            status: "ready",
            windows: [
              { key: "five_hour", remainingPercent: 72, resetsAt: inHours(2) },
            ],
          },
        ],
      },
      { now: NOW },
    )

    assert.equal(parsed.nodes[0].windows[0].kind, "monthly")
    assert.equal(parsed.nodes[0].windows[0].used, 60)
    assert.equal(parsed.nodes[0].windows[0].amount, 36)
    assert.equal(parsed.nodes[0].windows[0].limit, 60)

    assert.equal(parsed.nodes[1].windows[0].kind, "five_hour")
    assert.equal(parsed.nodes[1].windows[0].used, 28)
  })

  it("parses Fable & Mythos sub-windows from camelCase, overage_included, weekly_scoped, nested snapshot, and flat fields", () => {
    const parsed = parseCchostUsage(
      {
        nodes: [
          {
            id: "n-camel",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            snapshot: {
              fiveHour: { utilization: 15, resetsAt: inHours(2) },
              sevenDay: { utilization: 25, resetsAt: inDays(4) },
              sevenDayFable: { utilization: 70, resetsAt: inDays(4) },
              sevenDayOpus: { utilization: 40, resetsAt: inDays(4) },
            },
          },
          {
            id: "n-scoped",
            accountType: "claude",
            plan: "Max 5x",
            status: "ready",
            quota: {
              five_hour: { usedPercentage: 10, resets_at: inHours(3) },
              seven_day: { usedPercentage: 30, resets_at: inDays(5) },
              weekly_scoped: {
                Fable: { usedPercentage: 82, resets_at: inDays(5) },
                "Fable 5.1": { usedPercentage: 45, resets_at: inDays(5) },
              },
            },
          },
          {
            id: "n-overage",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            windows: [
              { name: "Current session", utilization: 20, resetsAt: inHours(1) },
              { name: "Current week", utilization: 35, resetsAt: inDays(3) },
              { key: "seven_day_overage_included", name: "Current week (Fable)", utilization: 55, resetsAt: inDays(3) },
            ],
          },
          {
            id: "n-flat",
            accountType: "claude",
            plan: "Max 5x",
            status: "ready",
            fiveHourUtilization: 12,
            sevenDayUtilization: 22,
            fableUtilization: 66,
            fableResetsAt: inDays(6),
          },
        ],
      },
      { now: NOW },
    )

    const wCamelFable = parsed.nodes[0].windows.find((w) => w.model === "fable")
    const wCamelOpus = parsed.nodes[0].windows.find((w) => w.model === "opus")
    assert.equal(wCamelFable.kind, "model_seven_day")
    assert.equal(wCamelFable.used, 70)
    assert.equal(wCamelOpus.kind, "model_seven_day")
    assert.equal(wCamelOpus.used, 40)

    const wScopedFable = parsed.nodes[1].windows.find((w) => w.model === "fable")
    const wScopedFable51 = parsed.nodes[1].windows.find((w) => w.model === "fable-5-1")
    assert.equal(wScopedFable.kind, "model_seven_day")
    assert.equal(wScopedFable.used, 82)
    assert.equal(wScopedFable51.kind, "model_seven_day")
    assert.equal(wScopedFable51.used, 45)

    const wOverage = parsed.nodes[2].windows.find((w) => w.model === "fable")
    assert.equal(wOverage.kind, "model_seven_day")
    assert.equal(wOverage.used, 55)

    const wFlatFable = parsed.nodes[3].windows.find((w) => w.model === "fable")
    assert.equal(wFlatFable.kind, "model_seven_day")
    assert.equal(wFlatFable.used, 66)
  })

  it("unpacks nested data.nodes, group members[], and object-map limits", () => {
    const parsed = parseCchostUsage(
      {
        data: {
          nodes: [
            {
              id: "grp-1",
              name: "Claude Group",
              accountType: "claude",
              isGroup: true,
              members: [
                {
                  node_id: "m-1",
                  node_name: "Account-A",
                  plan: "Max 20x",
                  status: "ready",
                  limits: {
                    five_hour: { utilization: 15, resets_at: inHours(3) },
                    seven_day: { utilization: 35, resets_at: inDays(5) },
                    seven_day_fable: { utilization: 60, resets_at: inDays(5) },
                  },
                },
                {
                  node_id: "m-2",
                  node_name: "Account-B",
                  plan: "Pro",
                  status: "ready",
                  limits: {
                    five_hour: { utilization: 40, resets_at: inHours(2) },
                    seven_day: { utilization: 50, resets_at: inDays(4) },
                  },
                },
              ],
            },
          ],
        },
      },
      { now: NOW },
    )

    assert.equal(parsed.nodes.length, 2)
    assert.equal(parsed.nodes[0].id, "m-1")
    assert.equal(parsed.nodes[0].name, "Account-A")
    assert.equal(parsed.nodes[0].accountType, "claude")
    assert.equal(parsed.nodes[0].windows.find((w) => w.model === "fable").used, 60)
    assert.equal(parsed.nodes[1].id, "m-2")
    assert.equal(parsed.nodes[1].name, "Account-B")
    assert.equal(parsed.nodes[1].windows.find((w) => w.kind === "five_hour").used, 40)
  })
})
