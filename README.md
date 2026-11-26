# `magpie-cchost-auth`

Provider plugin for **[CC Host (`cchost.ai`)](https://cchost.ai/docs/usage)** on Magpie.

将 CC Host 接入点（Base URL + API Key）作为 **Magpie 订阅账号**接入，自动感知上游 **5 小时（5h）与 7 天（7d）额度窗口及重置时间**，并针对 CC Host 接入点聚合多个上游订阅账号/账号组（**订阅聚合**）的场景提供精确的额度透传与聚合计算。

> 零外部运行时依赖（纯标准 ESM JavaScript），同时兼容 **Bun（Magpie 插件宿主）** 与 **Node.js 22+（本地 Mock 与测试）**。

---

## 核心特性

1. **订阅级 5h / 7d 与模型子窗口（Fable / Opus / Sonnet / Mythos）额度感知（`auth.usage`）**
   - 对接 CC Host `GET /v1/usage`，透传标准 Magpie `5 hours`（`span: 18000`）与 `7 days`（`span: 604800`）窗口，以及模型子窗口（如 `7 days · Fable`、`7 days · Fable 5.1`、`7 days · Opus`、`7 days · Sonnet`、`7 days · Mythos`，兼容 `seven_day_overage_included` / `sevenDayFable` / `weekly_scoped` 等多种字段写法）和重置券（`resets`）。
   - **默认散开展示每个聚合订阅的独立进度条**：当接入点聚合了多个上游账号时，除顶部用于驱动 Magpie 路由的聚合总池（`5 hours` / `7 days` / `7 days · Fable`）外，默认在下方散开展示**每个上游账号各自的 5h、7d、Fable/Opus 进度条与重置倒计时**（标记为 `aside: true`，仅展示不干扰路由；可在提供商编辑页一键关闭）。
   - 直接适配 Magpie 的用量卡片、托盘状态栏、`magpie quota`、`GET /v1/magpie/quotas` 以及 `Smart` / `Pace` / `LeastUsed` / `Drain` 路由。
2. **多订阅聚合计算引擎（Subscription Aggregation）**
   - **避免 `summary.maxUtilization` 误判**：不会因为聚合池中某一个账号满额就让 Magpie 误判整个接入点不可用。
   - **5h / 7d 跨窗口阻塞耦合（Cross-Window Coupling）**：自动识别“7d 已满导致剩余 5h 搁浅（不可用）”的场景，防止节点 A 卡 7d、节点 B 卡 5h 时池子表面显示 50% 实则 100% 不可用。
   - **套餐容量加权（Capacity-Weighted Pool）**：按套餐容量权重（如 Claude Max 20x / 5x / Pro 1x，Codex Pro 10x / Plus 1x，或共享账号组成员数，并支持 API 显式 `weight` 与用户自定义权重覆盖）计算池化占用率，与 CC Host 控制台账号组进度条语义对齐。
   - **异构多厂商隔离（Heterogeneous Pool Scoping）**：同一接入点同时聚合 Claude、Codex、Gemini、Google AI Studio 等多类账号时，自动按账号类型及模型重叠关系拆分 `models` 作用域窗口——Claude 用满只阻塞 Claude 独占模型，不阻塞 Codex/Gemini 或由 Gemini 兜底的重叠模型。
   - **精准重置时间语义**：池子满额时取最早解封时间（含双阻塞取 `max(t_5h, t_7d)` 后的节点间 `min`）；池子有余量时，7d 取未用完节点的最早过期时间（契合 Magpie Smart 路由「临近重置优先消耗」），5h 取最早回落时间。
3. **三协议原生推理代理（`auth.loader` + `provider.models`）**
   - 通过 `GET /v1/models` 动态发现模型并按 CC Host 协议支持表映射 AI SDK 协议（Anthropic `/v1/messages`、OpenAI `/v1/responses`、OpenAI `/v1/chat/completions` + `also`）。
   - 遵循 CC Host 文档要求每次仅发送单一鉴权头（`/v1/messages*` 发 `x-api-key`，OpenAI 路径发 `Authorization: Bearer`），并透传会话 ID 保持上游账号粘性与缓存命中。
   - 精准区分 `401`（`X-Magpie-Sign-In: expired`）与 `502 [cchost] No healthy nodes` / `404` / `429`（`X-Magpie-Sign-In: kept`），不会因为上游暂时无健康节点而误标 API Key 失效。

---

## 订阅聚合额度计算模型详解

当 CC Host 接入点聚合了多个订阅账号 $i \in \{1, \dots, n\}$ 时，插件按以下流程透传并计算额度：

### 1. 节点归一化与过期修正（`lib/usage-parser.mjs`）
- **比例/百分比自适应识别**：兼容 `0..1`（如 `0.42`）与 `0..100`（如 `42`），也支持在插件选项中显式配置 `utilizationScale: "ratio" | "percent"`。
- **快照过期归零**：若某节点的窗口 `resetsAt <= now`，在聚合前先将该窗口归零（`used = 0`），避免缓存快照导致已重置节点仍被当作 100%。
- **闲置未开启 5h 窗口**：对 5h+7d 类型账号，若仅上报了 `seven_day` 而未上报 `five_hour`（超过 5h 未调用），按 `5h = 0%` 参与计算；若两个窗口均无数据（采集中），绝不伪造 `0%`（避免 Magpie 误认为满血可用）。
- **状态分类**：`offline` / `paused` / `needs_login` 节点不计入活跃可用分母；若全部节点均不可用，返回 `No healthy nodes` 错误并置 `signIn: "kept"`。

### 2. 跨窗口阻塞耦合（Cross-Window Bottleneck Coupling）
对于每个活跃订阅节点 $i$（原始占用率 $u_{5h,i}, u_{7d,i}$，重置时间 $t_{5h,i}, t_{7d,i}$）：
- 若 $u_{7d,i} \ge 100$（或节点状态为 `quota_exhausted`）：该节点无法继续服务请求，其剩余 5h 额度处于**搁浅状态**，因此：
  $$u_{5h,i}^{\text{eff}} = 100\%, \quad t_{\text{unblock},i} = \begin{cases} \max(t_{5h,i}, t_{7d,i}) & \text{if } u_{5h,i} \ge 100 \land u_{7d,i} \ge 100 \\ t_{7d,i} & \text{if only } u_{7d,i} \ge 100 \\ t_{5h,i} & \text{if only } u_{5h,i} \ge 100 \end{cases}$$
- 若 $u_{5h,i} \ge 100$ 且 $t_{5h,i} \ge t_{7d,i}$：该节点在周额度重置前已无法继续消耗，故 $u_{7d,i}^{\text{eff}} = 100\%$。

### 3. 四种聚合策略（登录时可选，支持 `plugins.json` 覆盖）

| 策略 | 公式 | 适用场景 |
| --- | --- | --- |
| `weighted`（默认，推荐） | $\dfrac{\sum_i w_i \cdot \min(u_i^{\text{eff}}, 100)}{\sum_i w_i}$ | 按套餐容量权重池化（20x / 5x / 1x / 共享组人数），真实反映总剩余容量；只要还有可用节点，防浮点进位到 `100%`（上限 `99.9%`） |
| `min_used` | $\min_i u_i^{\text{eff}}$ | 反映最空闲可用节点，仅当全池受限时到达 `100%` |
| `max_used` | $\max_i u_i^{\text{eff}}$ | 保守预警，对齐 CC Host `summary.maxUtilization` |
| `average` | $\dfrac{1}{k}\sum_i \min(u_i^{\text{eff}}, 100)$ | 同规格账号等权均值 |

权重优先级：**用户 `nodeWeights` > CC Host API `weight` > 套餐权重（`tierWeights` / 内置表）× 共享组人数 > `1`**。

### 4. 重置时间（`resetsAt`）聚合规则
- **全池满额（$U \ge 100$）**：取所有受阻节点中最早的解封时间 $\min_i t_{\text{unblock},i}$ —— Magpie 路由会在该时刻自动解除限流挂起。
- **有余量（$U < 100$）**：
  - **7d 窗口**：取仍有剩余周额度（$u_{7d,i}^{\text{eff}} < 100$）节点中的最早重置时间，直接配合 Magpie `Smart` 策略优先消耗即将过期的周额度。
  - **5h 窗口**：取已产生消耗（$u_{5h,i}^{\text{eff}} > 0$）节点中的最早重置时间（池子占用率最早开始回落的时刻）。

### 5. 异构接入点（多类型聚合）处理
当接入点同时包含 `claude`、`codex`、`gemini`、`aistudio` 等多类账号时：
- 按 `(可服务该模型的账号类型集合)` 自动分组输出模型级窗口（例如 `Claude · 5 hours` 仅作用域到 `claude-opus-4-6`，`Codex · 5 hours` 仅作用域到 `gpt-5.4`，`Claude + Gemini · 5 hours` 作用域到两类账号共同服务的 `claude-sonnet-4-6`）。
- Google AI Studio / OpenAI 等按量 API Key 账号无 5h/7d 窗口，以 `aside: true` 展示，不干扰订阅额度路由。
- 若希望强制合并为一个全局 5h/7d 视图，可在 Magpie 提供商编辑页开启插件选项 **「合并异构账号类型为统一 5h/7d 窗口」**（`force_global_windows`）。

---

## 三种显示模式（普通接入时直接选择，无需导入文件）

通过 **「CC Host 接入点（Base URL + API Key）」** 普通接入时，可在 **「多账号展示方式」** 中任选其一：

1. **1 张端点卡 + 卡内展开各节点进度条（`single`，默认推荐）**
   - 最贴合 CC Host 物理架构：1 个接入点在 Magpie 里只占 **1 个席位**，路由与缓存粘性完全交由 CC Host 上游维护；
   - Usage 页顶部展示参与路由的聚合总池（`5 hours`、`7 days`、`7 days · Fable`），下方默认散开展示每个上游节点的独立进度条（`aside: true`，仅展示不干扰路由，可通过 `show_node_breakdown` 开关随时收起）。
2. **拆成 N 张独立节点卡（`nodes_only`，有几个上游号就建几张卡）**
   - 直接生成 **精确 N 张独立卡片**（例如 3 个上游节点就是 3 张卡，Magpie 顶部准确显示 **「全部 3 个账号」**，没有多余的汇总主卡）；
   - 每张卡拥有独立的 5h / 7d / Fable 进度条和历史曲线；并发刷新 `/v1/usage` 与 `/v1/models` 均有 3 秒合并缓存（只发 1 次请求）。
   - 文件导入（`auth.import`，支持 JSON / Claude Code `settings.json` / `.env`）默认也采用纯 N 卡模式。
3. **1 张汇总路由卡 + N 张只读节点子卡（`split_with_primary`，共 N+1 张）**
   - 仅主卡暴露模型并负责路由，N 张子卡设为 `usageOnly`（空模型表）纯做独立曲线观测（Magpie 顶部会计数为 N+1；文件导入时显式设置 `"includeEndpointCard": true` 可启用）。
   - 同时保留 **「CC Host 单个上游账号（独立额度卡片）」** 登录方式用于手动单加某一个节点。

---

## 本地 Mock 与测试（零线上操作）

所有测试与 Mock 均严格绑定在 `127.0.0.1`，不发起任何外部网络请求。

### 运行全部单元测试与本地 Mock 端到端测试

```bash
npm test
# 或
node --test --test-reporter=spec test/*.test.mjs
```

### 启动本地 CC Host Mock 服务器（供本机 Magpie 沙箱联调）

```bash
node mock/cchost-mock-server.mjs
# 默认监听 http://127.0.0.1:18787（可通过 PORT 环境变量修改）
```

内置 6 个开箱即用的本地 Mock 场景 Key：
- `cchost_mock_single_claude`：单账号 Claude Max 20x（含 5h / 7d / Opus 子窗口 / 重置券，0..1 ratio 格式）
- `cchost_mock_claude_pool`：同构 3 账号加权聚合（Max 20x + Max 5x 满额 + Pro 1x）
- `cchost_mock_deadlock`：跨窗口阻塞死锁（节点 A 7d 满 + 节点 B 5h 满，验证有效 5h=100% 且最早 1.5h 解封）
- `cchost_mock_hetero`：异构多厂商聚合（Claude 满 + Codex 正常 + Gemini 正常与 Sonnet 重叠 + AI Studio PAYG）
- `cchost_mock_shared_group`：共享账号组（6/8 ready）+ 个人账号 + 离线自托管账号
- `cchost_mock_offline`：全员离线（验证 `502 [cchost] No healthy nodes` 不误标密钥失效）

---

## 在本机 Magpie 沙箱中试用

按照 Magpie 官方插件开发指南，在独立 `HOME` 沙箱中加载本地文件夹（不影响真实 Magpie 配置）：

```bash
# 终端 1：启动本地 Mock 服务
node ./mock/cchost-mock-server.mjs

# 终端 2：在独立沙箱中加载插件并连接本地 Mock（不触碰任何线上地址）
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

m plugin add "$(pwd)"
m plugin login cchost
# Base URL 填 http://127.0.0.1:18787
# API Key  填 cchost_mock_claude_pool
# Label    填 team-claude
# Strategy 选 weighted

m plugin --json
m quota
m provider test cchost
```

---

## 高级配置（Magpie `plugins.json` 的 `options`）

在 Magpie 的 **Plugins → Installed → CC Host → Options** 中可配置以下可选参数：

```json
{
  "aggregation": "weighted",
  "utilizationScale": "auto",
  "crossWindowCoupling": true,
  "nodeWeights": {
    "node-claude-main": 20,
    "node-claude-backup": 5
  },
  "tierWeights": {
    "claude:max_20x": 20,
    "claude:max_5x": 5,
    "claude:pro": 1,
    "codex:pro": 10,
    "codex:plus": 1
  },
  "requestTimeoutMs": 15000
}
```

此外，在 Magpie 提供商编辑页还提供两个即时生效的插件开关（`auth.options`）：
- `show_node_breakdown`：在用量卡片下方附加每个上游节点的 `5h / 7d` 明细行（`aside: true`，仅展示不影响路由）。
- `force_global_windows`：将异构接入点强制合并为全局 `5 hours` / `7 days` 视图。
