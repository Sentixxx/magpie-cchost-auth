import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseCchostUsage } from "../lib/usage-parser.mjs"
import { aggregateCchostUsage } from "../lib/quota-aggregator.mjs"
import {
  hostNormalizeUsage,
  goQuotaOfPlugin,
  goAllowanceOf,
  goSmartOrder,
  guiQuotaText,
} from "./magpie-contract.mjs"

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const inHours = (h) => new Date(NOW + h * 3600_000).toISOString()
const inDays = (d) => new Date(NOW + d * 86400_000).toISOString()

function runPipeline(rawPayload, opts = {}) {
  const parsed = parseCchostUsage(rawPayload, { now: NOW, ...opts })
  const usage = aggregateCchostUsage(parsed, { now: NOW, ...opts })
  const host = hostNormalizeUsage(usage)
  const quota = goQuotaOfPlugin(host)
  const allowance = goAllowanceOf(quota, NOW)
  return { parsed, usage, host, quota, allowance }
}

describe("aggregateCchostUsage — single account", () => {
  it("passes through 5h, 7d, and Opus sub-windows 1:1 like a native subscription", () => {
    const { usage, host, quota, allowance } = runPipeline(
      {
        endpoint: { name: "personal-claude" },
        nodes: [
          {
            id: "c1",
            accountType: "claude",
            plan: "Max 20x",
            status: "ready",
            windows: {
              five_hour: { utilization: 0.35, resetsAt: inHours(2) },
              seven_day: { utilization: 0.5, resetsAt: inDays(4) },
              seven_day_opus: { utilization: 0.8, resetsAt: inDays(4) },
            },
          },
        ],
      },
      { label: "personal-claude" },
    )

    assert.equal(usage.plan, "Claude Max 20x")
    assert.equal(usage.user, "personal-claude")
    assert.equal(usage.windows.length, 3)

    const [w5, w7, wOpus] = usage.windows
    assert.equal(w5.name, "5 hours")
    assert.equal(w5.used, 35)
    assert.equal(w5.span, 18000)
    assert.equal(w5.display, undefined) // single account renders cleanly as "35% used"
    assert.equal(guiQuotaText(host.windows[0]), "35% used")

    assert.equal(w7.name, "7 days")
    assert.equal(w7.used, 50)
    assert.equal(w7.span, 604800)

    assert.equal(wOpus.name, "7 days · Opus")
    assert.equal(wOpus.model, "opus")
    assert.equal(wOpus.used, 80)

    // Verify Magpie routing sees Opus at 80% and Sonnet at 50%
    assert.equal(allowance.forModel("claude-opus-4-6").used, 80)
    assert.equal(allowance.forModel("claude-sonnet-4-6").used, 50)
    assert.equal(quota.windows.length, 3)
  })
})

describe("aggregateCchostUsage — homogeneous multi-subscription aggregation", () => {
  const poolPayload = {
    endpoint: { name: "claude-team" },
    summary: { maxUtilization: 100 },
    nodes: [
      {
        id: "max20",
        name: "Max20x",
        accountType: "claude",
        plan: "Max 20x", // weight 20
        status: "ready",
        windows: {
          five_hour: { utilization: 20, resetsAt: inHours(4) },
          seven_day: { utilization: 30, resetsAt: inDays(5) },
        },
      },
      {
        id: "max5",
        name: "Max5x",
        accountType: "claude",
        plan: "Max 5x", // weight 5
        status: "quota_exhausted",
        windows: {
          five_hour: { utilization: 100, resetsAt: inHours(1) },
          seven_day: { utilization: 60, resetsAt: inDays(2) },
        },
      },
      {
        id: "pro1",
        name: "Pro1x",
        accountType: "claude",
        plan: "Pro", // weight 1
        status: "ready",
        windows: {
          five_hour: { utilization: 80, resetsAt: inHours(3) },
          seven_day: { utilization: 90, resetsAt: inDays(1) },
        },
      },
    ],
  }

  it("computes capacity-weighted 5h and 7d utilization and exact reset semantics", () => {
    const { usage, host, allowance } = runPipeline(poolPayload, { aggregation: "weighted" })

    // Total weight = 20 + 5 + 1 = 26
    // 5h weighted = (20*20 + 100*5 + 80*1) / 26 = 980 / 26 = 37.69 -> 37.7%
    // 7d weighted = (30*20 + 60*5 + 90*1) / 26 = 990 / 26 = 38.07 -> 38.1%
    const w5 = usage.windows.find((w) => w.name === "5 hours")
    const w7 = usage.windows.find((w) => w.name === "7 days")

    assert.equal(w5.used, 37.7)
    assert.equal(w7.used, 38.1)

    // 5h reset = earliest drop among active nodes = 1h (Max5x recovering!)
    assert.equal(w5.resetsAt, Date.parse(inHours(1)))
    // 7d reset = earliest expiry among nodes with unspent weekly quota = 1d (Pro1x expiring soonest!)
    assert.equal(w7.resetsAt, Date.parse(inDays(1)))

    // Display has pool summary WITHOUT duplicate percentage
    assert.equal(w5.display, "2/3 ready · 26x")
    assert.equal(guiQuotaText(host.windows[0]), "2/3 ready · 26x · 37.7% used")

    // Unlike naive summary.maxUtilization (100%), Magpie does NOT bench this healthy pool!
    assert.equal(allowance.full("claude-sonnet-4-6", 100, NOW), 0)
  })

  it("supports min_used, max_used, and average aggregation strategies", () => {
    const minRes = runPipeline(poolPayload, { aggregation: "min_used" })
    assert.equal(minRes.usage.windows[0].used, 20) // Max20x 5h
    assert.equal(minRes.usage.windows[1].used, 30) // Max20x 7d

    const maxRes = runPipeline(poolPayload, { aggregation: "max_used" })
    assert.equal(maxRes.usage.windows[0].used, 100) // Max5x 5h
    assert.equal(maxRes.usage.windows[1].used, 90) // Pro1x 7d
    // Under conservative max_used, 5h=100% triggers Magpie full-bench until Max5x resets in 1h
    assert.equal(maxRes.allowance.full("claude-sonnet-4-6", 100, NOW), Date.parse(inHours(1)))

    const avgRes = runPipeline(poolPayload, { aggregation: "average" })
    // (20 + 100 + 80) / 3 = 66.7; (30 + 60 + 90) / 3 = 60
    assert.equal(avgRes.usage.windows[0].used, 66.7)
    assert.equal(avgRes.usage.windows[1].used, 60)
  })

  it("guards against floating-point rounding up to 100% when a small node still has headroom", () => {
    const { usage, allowance } = runPipeline(
      {
        nodes: [
          {
            id: "huge",
            accountType: "claude",
            weight: 1000,
            status: "quota_exhausted",
            windows: {
              five_hour: { utilization: 100, resetsAt: inHours(2) },
              seven_day: { utilization: 50, resetsAt: inDays(3) },
            },
          },
          {
            id: "tiny",
            accountType: "claude",
            weight: 1,
            status: "ready",
            windows: {
              five_hour: { utilization: 60, resetsAt: inHours(3) },
              seven_day: { utilization: 50, resetsAt: inDays(3) },
            },
          },
        ],
      },
      { aggregation: "weighted" },
    )

    // Raw weighted = (100000 + 60) / 1001 = 99.9600... must clamp to 99.9, NOT 100!
    assert.equal(usage.windows[0].used, 99.9)
    assert.equal(allowance.full("claude-sonnet-4-6", 100, NOW), 0)
  })
})

describe("aggregateCchostUsage — 5h/7d cross-window bottleneck coupling", () => {
  it("prevents stranded 5h quota on a 7d-exhausted node from masking total pool exhaustion", () => {
    const payload = {
      nodes: [
        {
          id: "n1",
          accountType: "claude",
          plan: "Pro",
          status: "quota_exhausted",
          windows: {
            five_hour: { utilization: 10, resetsAt: inHours(4) },
            seven_day: { utilization: 100, resetsAt: inDays(2) },
          },
        },
        {
          id: "n2",
          accountType: "claude",
          plan: "Pro",
          status: "quota_exhausted",
          windows: {
            five_hour: { utilization: 100, resetsAt: inHours(1.5) },
            seven_day: { utilization: 20, resetsAt: inDays(5) },
          },
        },
      ],
    }

    const { usage, allowance } = runPipeline(payload, {
      aggregation: "weighted",
      crossWindowCoupling: true,
    })

    // Effective 5h: n1 is blocked by 7d -> 100%, n2 is blocked by 5h -> 100% => Pool 5h = 100%!
    const w5 = usage.windows.find((w) => w.name === "5 hours")
    const w7 = usage.windows.find((w) => w.name === "7 days")
    assert.equal(w5.used, 100)
    // Earliest unblock: min(n1's 7d reset = 2d, n2's 5h reset = 1.5h) = 1.5h!
    assert.equal(w5.resetsAt, Date.parse(inHours(1.5)))
    // 7d pool itself still has 80% left on n2 -> weighted 7d = (100 + 20) / 2 = 60%
    assert.equal(w7.used, 60)
    // Magpie immediately knows the endpoint cannot serve until 1.5h!
    assert.equal(allowance.full("claude-sonnet-4-6", 100, NOW), Date.parse(inHours(1.5)))
  })

  it("uses max(5h reset, 7d reset) when a single node is blocked on BOTH 5h and 7d", () => {
    const payload = {
      nodes: [
        {
          id: "both-full",
          accountType: "claude",
          plan: "Pro",
          status: "quota_exhausted",
          windows: {
            five_hour: { utilization: 100, resetsAt: inHours(1) },
            seven_day: { utilization: 100, resetsAt: inDays(3) },
          },
        },
      ],
    }

    const { usage } = runPipeline(payload, { crossWindowCoupling: true })
    // Even though 5h resets in 1h, the node won't actually serve until 7d resets in 3d!
    assert.equal(usage.windows[0].used, 100)
    assert.equal(usage.windows[0].resetsAt, Date.parse(inDays(3)))
  })

  it("handles model sub-windows cleanly when only a subset of nodes enforce them", () => {
    const payload = {
      nodes: [
        {
          id: "with-opus-cap",
          accountType: "claude",
          plan: "Pro",
          status: "ready",
          windows: {
            five_hour: { utilization: 30, resetsAt: inHours(2) },
            seven_day: { utilization: 40, resetsAt: inDays(3) },
            seven_day_opus: { utilization: 100, resetsAt: inDays(3) },
          },
        },
        {
          id: "without-opus-cap",
          accountType: "claude",
          plan: "Pro",
          status: "ready",
          windows: {
            five_hour: { utilization: 10, resetsAt: inHours(4) },
            seven_day: { utilization: 20, resetsAt: inDays(5) },
          },
        },
      ],
    }

    const { usage, allowance } = runPipeline(payload)
    const opus = usage.windows.find((w) => w.model === "opus")
    // Node 1 Opus=100, Node 2 falls back to general 7d=20 -> weighted (100+20)/2 = 60% (NOT 100%!)
    assert.equal(opus.used, 60)
    assert.equal(allowance.full("claude-opus-4-6", 100, NOW), 0)
  })
})

describe("aggregateCchostUsage — heterogeneous multi-vendor endpoint", () => {
  it("isolates Claude, Codex, Gemini, and overlapping models into scoped pools so full Claude never blocks Codex", () => {
    const payload = {
      endpoint: { name: "all-in-one" },
      nodes: [
        {
          id: "cl-1",
          accountType: "claude",
          plan: "Max 5x",
          status: "quota_exhausted",
          models: ["claude-opus-4-6", "claude-sonnet-4-6"],
          windows: {
            five_hour: { utilization: 100, resetsAt: inHours(2) },
            seven_day: { utilization: 85, resetsAt: inDays(3) },
          },
        },
        {
          id: "cx-1",
          accountType: "codex",
          plan: "Pro",
          status: "ready",
          models: ["gpt-5.4"],
          windows: {
            five_hour: { utilization: 12, resetsAt: inHours(4) },
            seven_day: { utilization: 25, resetsAt: inDays(6) },
          },
        },
        {
          id: "gm-1",
          accountType: "gemini",
          plan: "Pro",
          status: "ready",
          models: ["gemini-2.5-pro", "claude-sonnet-4-6"],
          windows: {
            five_hour: { utilization: 20, resetsAt: inHours(3) },
            seven_day: { utilization: 15, resetsAt: inDays(5) },
          },
        },
        {
          id: "as-1",
          accountType: "aistudio",
          status: "ready",
          models: ["aistudio/gemini-2.5-flash"],
          windows: [],
        },
      ],
    }

    const { usage, allowance } = runPipeline(payload, {
      catalogModels: [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "gpt-5.4",
        "gemini-2.5-pro",
        "aistudio/gemini-2.5-flash",
      ],
    })

    // 1. claude-opus-4-6 is served ONLY by Claude -> 100% blocked for 2h!
    assert.equal(allowance.forModel("claude-opus-4-6").used, 100)
    assert.equal(allowance.full("claude-opus-4-6", 100, NOW), Date.parse(inHours(2)))
    assert.equal(allowance.pooled("claude-opus-4-6", 100, NOW), true)

    // 2. gpt-5.4 is served ONLY by Codex -> 25% used (7d), NOT blocked!
    assert.equal(allowance.forModel("gpt-5.4").used, 25)
    assert.equal(allowance.full("gpt-5.4", 100, NOW), 0)

    // 3. gemini-2.5-pro is served ONLY by Gemini -> 20% used, NOT blocked!
    assert.equal(allowance.forModel("gemini-2.5-pro").used, 20)
    assert.equal(allowance.full("gemini-2.5-pro", 100, NOW), 0)

    // 4. claude-sonnet-4-6 is served by BOTH Claude (5x, 100%) AND Gemini (1x, 20%):
    //    Weighted 5h = (100*5 + 20*1) / 6 = 86.7% -> STILL USABLE because Gemini can serve it!
    assert.equal(allowance.forModel("claude-sonnet-4-6").used, 86.7)
    assert.equal(allowance.full("claude-sonnet-4-6", 100, NOW), 0)

    // 5. AI Studio PAYG note is aside-only (does not affect routing)
    const paygRow = usage.windows.find((w) => w.name.includes("Google AI Studio"))
    assert.equal(paygRow.aside, true)
  })
})

describe("aggregateCchostUsage — edge cases & Smart routing integration", () => {
  it("never invents 0% free quota when all nodes are still collecting", () => {
    const { usage, host, allowance } = runPipeline({
      nodes: [
        { id: "c1", accountType: "claude", status: "collecting", windows: [] },
      ],
    })

    assert.equal(usage.windows[0].used, undefined)
    assert.equal(host.windows[0].used, null)
    assert.equal(allowance.known, false)
    assert.equal(guiQuotaText(host.windows[0]), "Collecting quota…")
  })

  it("does not hard-bench a pool at 100% when a known node is full but another ready node is still collecting", () => {
    const { usage, allowance } = runPipeline(
      {
        nodes: [
          {
            id: "full-1",
            accountType: "claude",
            plan: "Pro",
            status: "quota_exhausted",
            windows: {
              five_hour: { utilization: 100, resetsAt: inHours(1) },
              seven_day: { utilization: 50, resetsAt: inDays(3) },
            },
          },
          {
            id: "collecting-2",
            accountType: "claude",
            plan: "Pro",
            status: "ready",
            windows: [],
          },
        ],
      },
      { aggregation: "weighted" },
    )

    assert.equal(usage.windows[0].used, 99.9)
    assert.match(usage.windows[0].display, /\+1 collecting/)
    assert.equal(allowance.full("claude-sonnet-4-6", 100, NOW), 0)
  })

  it("treats an idle 5h+7d account with seven_day present and five_hour unstarted as 0% on 5h", () => {
    const { usage } = runPipeline(
      {
        nodes: [
          {
            id: "active-1",
            accountType: "claude",
            plan: "Pro",
            status: "ready",
            windows: {
              five_hour: { utilization: 60, resetsAt: inHours(2) },
              seven_day: { utilization: 40, resetsAt: inDays(3) },
            },
          },
          {
            id: "idle-2",
            accountType: "claude",
            plan: "Pro",
            status: "ready",
            windows: {
              seven_day: { utilization: 20, resetsAt: inDays(5) },
            },
          },
        ],
      },
      { aggregation: "weighted" },
    )

    // (60 + 0) / 2 = 30% on 5h; (40 + 20) / 2 = 30% on 7d
    assert.equal(usage.windows[0].used, 30)
    assert.equal(usage.windows[1].used, 30)
  })

  it("reports non-auth error with signIn='kept' when all nodes are offline", () => {
    const { usage } = runPipeline({
      nodes: [
        { id: "off1", accountType: "claude", status: "offline", windows: {} },
        { id: "off2", accountType: "claude", status: "paused", windows: {} },
      ],
    })
    assert.equal(usage.signIn, "kept")
    assert.match(usage.error, /No healthy nodes/)
    assert.deepEqual(usage.windows, [])
  })

  it("aggregates tier-gated Fable quota across Fable-capable nodes without Pro nodes diluting it", () => {
    const payload = {
      nodes: [
        {
          id: "max-20",
          name: "Max20x",
          accountType: "claude",
          plan: "Max 20x", // weight 20
          status: "ready",
          windows: {
            five_hour: { utilization: 20, resetsAt: inHours(4) },
            seven_day: { utilization: 30, resetsAt: inDays(5) },
            seven_day_overage_included: { utilization: 50, resetsAt: inDays(5) },
          },
        },
        {
          id: "max-5",
          name: "Max5x",
          accountType: "claude",
          plan: "Max 5x", // weight 5
          status: "ready",
          windows: {
            five_hour: { utilization: 40, resetsAt: inHours(2) },
            seven_day: { utilization: 60, resetsAt: inDays(2) },
            sevenDayFable: { utilization: 100, resetsAt: inDays(2) },
          },
        },
        {
          id: "pro-1",
          name: "Pro1x",
          accountType: "claude",
          plan: "Pro", // weight 1, NO Fable window!
          status: "ready",
          windows: {
            five_hour: { utilization: 0, resetsAt: inHours(5) },
            seven_day: { utilization: 5, resetsAt: inDays(6) },
          },
        },
      ],
    }

    const { usage, allowance } = runPipeline(payload, { aggregation: "weighted" })
    const fable = usage.windows.find((w) => w.model === "fable" && !w.aside)
    // Weighted across ONLY the 2 Fable-capable nodes (20x at 50%, 5x at 100%):
    // (50*20 + 100*5) / 25 = 1500 / 25 = 60% (NOT diluted by Pro1x!)
    assert.equal(fable.name, "7 days · Fable")
    assert.equal(fable.used, 60)
    // Fable resetsAt = soonest expiry among Fable nodes with remaining quota -> Max20x (5d)
    assert.equal(fable.resetsAt, Date.parse(inDays(5)))
    assert.equal(allowance.forModel("claude-fable-5").used, 60)
    assert.equal(allowance.forModel("claude-sonnet-4-6").used, 34.8) // general 7d weighted across all 3
  })

  it("expands each upstream subscription into real aside progress bars (including 0% and Fable) without altering routing", () => {
    const payload = {
      nodes: [
        {
          id: "n1",
          name: "Primary",
          accountType: "claude",
          plan: "Max 20x",
          status: "ready",
          windows: {
            five_hour: { utilization: 0, resetsAt: inHours(5) },
            seven_day: { utilization: 20, resetsAt: inDays(4) },
            sevenDayFable: { utilization: 45, resetsAt: inDays(4) },
          },
        },
        {
          id: "n2",
          name: "Backup",
          accountType: "claude",
          plan: "Pro",
          status: "ready",
          windows: {
            five_hour: { utilization: 100, resetsAt: inHours(1) },
            seven_day: { utilization: 60, resetsAt: inDays(6) },
          },
        },
        {
          id: "n3",
          name: "Laptop",
          accountType: "claude_self_hosted",
          plan: "Pro",
          status: "offline",
          windows: {},
        },
      ],
    }

    const withBreakdown = runPipeline(payload, { showNodeBreakdown: true })
    const withoutBreakdown = runPipeline(payload, { showNodeBreakdown: false })

    // Primary has 3 bars (5h, 7d, Fable), Backup has 2 bars (5h, 7d), Laptop has 1 offline status row = 6 aside rows
    const asideRows = withBreakdown.usage.windows.filter((w) => w.aside)
    assert.equal(asideRows.length, 6)

    // Crucial Magpie UI contract: Primary's 0% aside bar MUST NOT turn into text (`w.text === false`)!
    const primary5hQuota = withBreakdown.quota.windows.find(
      (w) => w.aside && w.name === "Primary (Max 20x) · 5 hours",
    )
    assert.equal(primary5hQuota.used, 0)
    assert.equal(primary5hQuota.text, false)
    assert.equal(guiQuotaText(primary5hQuota), "0% used")

    const primaryFableQuota = withBreakdown.quota.windows.find(
      (w) => w.aside && w.name === "Primary (Max 20x) · 7 days · Fable",
    )
    assert.equal(primaryFableQuota.used, 45)
    assert.equal(primaryFableQuota.text, false)

    const laptopQuota = withBreakdown.quota.windows.find(
      (w) => w.aside && w.name === "Laptop (Pro)",
    )
    assert.equal(laptopQuota.text, true)
    assert.match(laptopQuota.display, /Unavailable/i)

    // Routing is 100% unaffected by Backup's 100% aside bar!
    assert.equal(withBreakdown.allowance.full("claude-sonnet-4-6", 100, NOW), 0)
    assert.equal(
      withBreakdown.allowance.forModel("claude-sonnet-4-6").used,
      withoutBreakdown.allowance.forModel("claude-sonnet-4-6").used,
    )
  })

  it("integrates with Magpie Smart routing to pick soonest-expiring endpoint before later-expiring and bench exhausted ones", () => {
    const epExpiringSoon = runPipeline({
      nodes: [
        {
          id: "a1",
          accountType: "claude",
          plan: "Max 5x",
          status: "ready",
          windows: {
            five_hour: { utilization: 30, resetsAt: inHours(3) },
            seven_day: { utilization: 40, resetsAt: inDays(1) }, // expires in 1 day
          },
        },
      ],
    })
    const epExpiringLater = runPipeline({
      nodes: [
        {
          id: "b1",
          accountType: "claude",
          plan: "Max 20x",
          status: "ready",
          windows: {
            five_hour: { utilization: 10, resetsAt: inHours(4) },
            seven_day: { utilization: 10, resetsAt: inDays(6) }, // expires in 6 days
          },
        },
      ],
    })
    const epExhausted = runPipeline({
      nodes: [
        {
          id: "c1",
          accountType: "claude",
          plan: "Pro",
          status: "quota_exhausted",
          windows: {
            five_hour: { utilization: 100, resetsAt: inHours(2) },
            seven_day: { utilization: 50, resetsAt: inDays(0.5) },
          },
        },
      ],
    })

    const order = goSmartOrder(
      [
        { id: "ep-exhausted", allowance: epExhausted.allowance },
        { id: "ep-later", allowance: epExpiringLater.allowance },
        { id: "ep-soon", allowance: epExpiringSoon.allowance },
      ],
      "claude-sonnet-4-6",
      NOW,
    )

    assert.deepEqual(order, ["ep-soon", "ep-later", "ep-exhausted"])
  })
})
