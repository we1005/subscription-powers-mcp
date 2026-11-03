# Dot 直连接口：实施记录、困难与解决，以及可借鉴 oh-my-pi 之处

> 2026-11-03。记录“用 ChatGPT Pro 的 Dot 做 Web Search MCP，并且直接调接口”这条路线从设计到跑通的全过程。
> 相关文档：方案设计 `dot-websearch-design.zh.md`（协议细节见其 §11）；oh-my-pi 的 Codex 搜索分析 `oh-my-pi-codex-websearch.zh.md`；之前的并发失败分析 `parallel-search-failure-analysis.zh.md`。

## 1. 摘要

| 项目 | 结果 |
|---|---|
| 目标 | Claude Code 走第三方中转、没有内置 WebSearch 时，用 Dot 提供搜索；Pro 到期后能一键关闭 |
| 路线 1：直接调接口 | **已完成并实测**：quick 约 15 秒，deep 约 18 秒，并发串行正确 |
| 路线 3：复用日常 Chrome + chrome-agent-bridge | **已完成并实测**：`subpow dot capture` 一条命令抓取并验证登录态；失效时可自动重抓（见 §9） |
| 路线 2：专用 Chrome + CDP | 暂缓；直连没被 Cloudflare 拦截，暂时不需要 |
| 开关 | 配置文件 + 热生效 + 自动熔断 + 命令行，已实测 |
| 测试 | 10 个单元测试通过，并抓到 1 个真实 bug |

## 2. 时间线

| # | 做了什么 | 结果 |
|---|---|---|
| 1 | 用 chrome-agent-bridge 连接你的 Chrome，找到 Dot 标签页，只读解析页面结构 | 连通；页面有“消息”输入框和“发送”按钮；Dot 有自己的电脑、插件、Slack |
| 2 | 写设计稿，推荐“专用 Chrome + CDP”，直连接口列为不推荐 | 你要求三条路都走通，直连优先 |
| 3 | 在 Dot 标签页开网络监听，发第 1 条测试消息 | 看到接口路径，但监听只记录脱敏元数据，看不到请求头 |
| 4 | 尝试导出 HAR | 失败：`raw_session_not_found` |
| 5 | 改用原始 CDP 会话，发第 2 条测试消息，导出 HAR | 成功：47 条请求，得到完整请求头与请求体结构 |
| 6 | 本地脚本分析 HAR，只打印字段名与长度；凭据写入 `~/.subscription-powers/`（0600） | 得到 Bearer、Cookie、设备 ID、`OpenAI-Sentinel-Token` 等必需项 |
| 7 | 从 Node 直接 `GET` 消息列表 | 200，Cloudflare 没拦 |
| 8 | 从 Node 直接 `POST` 发消息，不带 Sentinel 令牌（第 3 条测试消息） | 200，Dot 回复 “OK” |
| 9 | 验证令牌续期、房间列表 | 续期成功；账号只有 1 个房间 |
| 10 | 实现存储、客户端、命令行、MCP 工具、开关；写单元测试 | 测试抓到 URL 解析 bug，修复后 10/10 通过 |
| 11 | 端到端：quick、热开关、两进程并发、deep | 全部通过 |
| 12 | 清理：删 HAR、断开 CDP、删临时脚本、检查仓库无机密 | 完成 |

## 3. 遇到的困难与解决

### 3.1 监听工具只给脱敏数据，导出 HAR 失败

- **现象**：`browser_network_start` 能看到请求路径和状态，但没有请求头和请求体；`network_export_har` 报 `raw_session_not_found`。
- **原因**：监听器是“元数据模式”，HAR 导出需要“原始 CDP 会话”（`browser_cdp_attach`）的事件。
- **解决**：停掉监听，附加原始会话，再发一条消息重新抓。
- **代价**：多发了 1 条测试消息，Dot 对话里多了一条记录。
- **教训**：需要完整请求时，直接用原始会话，不要先走元数据模式。

### 3.2 不让机密进入对话记录

- **风险**：`browser_cdp_events`、`network_extract_auth`、`network_get_response_body` 都会把令牌和 Cookie 直接返回到对话里，而对话会被本地保存。
- **做法**：只用 `network_export_har` 写到本地文件，再用脚本读取，输出只打印“头名、值的长度、JSON 结构”。登录态由脚本直接写入 0600 文件。用完删除 HAR。
- **残留**：页面快照结果（含 Dot 页面可见文字、侧栏聊天标题）被工具保存在 `~/.claude/projects/…/tool-results/`，里面没有令牌，但有你的聊天标题。需要的话可以删。

### 3.3 担心 Sentinel 令牌，先测试再决定要不要实现

- **担心**：网页每次发消息前都调用 `POST /backend-api/sentinel/req`（流程名 `calpico_send_message`），再把约 2300 字符的 `OpenAI-Sentinel-Token` 放进请求头。如果服务端强制，就得复刻 OpenAI 的校验逻辑，或者让浏览器生成。
- **调查**：令牌结构只有两个字段 `e` 和 `c`；页面里有现成的 `window.SentinelSDK`（`init / requirementsToken / token / sessionObserverToken`），可以在页面上下文里生成。
- **关键一步**：没有急着实现，先用最小请求实测——不带令牌直接发。结果 **200**。
- **结论**：目前不强制，省掉了最麻烦的一块。保留后备：若以后被强制，用页面的 `SentinelSDK.token('calpico_send_message')` 生成（属于路线 2/3）。熔断机制负责在被强制时安全关闭。

### 3.4 担心 Cloudflare 拦截非浏览器客户端

- **担心**：`cf_clearance` 通常和浏览器指纹绑定。
- **做法**：先做只读的 `GET` 试探，再做发送。
- **结果**：带上抓到的 Cookie 和浏览器同款头（`user-agent`、`sec-ch-ua*`、`oai-client-version` 等），Node 的 `fetch` 直接 200。
- **保留的防线**：代码里把 `cf-mitigated: challenge` 或返回 HTML 归类为 `dot_blocked`，计入熔断。

### 3.5 抓不到响应体和实时流

- **现象**：HAR 里响应体长度为 0；`POST …/live`（SSE 推送流）不在 HAR 里。
- **原因**：HAR 导出不含响应体；`live` 流在我附加会话之前就已建立。
- **解决**：拿到凭据后，直接从 Node 调 `GET …/messages` 看响应结构。回复检测改用 1.5 秒轮询，不依赖 `live`。

### 3.6 分不清哪条是 Dot 的回复

- **现象**：消息条目的 `role` 两边都是 `user`；`reply_to` 也是空。
- **解决**：比较字段后发现：Dot 的回复 `account_user_id` 以 `calpico-member…` 开头（153 字符），`request_id` 为空，`turn_trigger` 是 `chatgpt_messaging`；我们自己的是 `user-…`（29 字符）。代码里 `pickReplies` 用“时间在我之后 + `account_user_id` 不同”来选。

### 3.7 只有一个房间，无法隔离，也无法对应请求和回复

- **现象**：房间列表只有 1 个 `DM`。
- **影响**：所有搜索都进同一个对话；设计稿里“每次新开聊天”不可能；多个会话同时搜索时回复可能串线。
- **解决**：
  - 每条请求带随机结束标记 `[[END:xxxxxx]]`，回复里出现它才算结束；
  - 回复稳定 15 秒仍没有标记，也返回，但带警告；
  - 跨进程文件锁 `~/.subscription-powers/dot.lock`（20 秒心跳，120 秒无心跳视为崩溃）加最小间隔；
  - 进程内再套一层现有的串行队列。
- **验证**：两个进程同时搜索，后到的等锁 16.6 秒，结果与各自问题一致。

### 3.8 等待类操作被拦

- **现象**：`sleep 45` 被执行环境禁止；用 `Runtime.evaluate` 做页面内等待，30 秒后 `bridge_timeout`。
- **处理**：不依赖长等待，Dot 的回复是用后面的接口调用读到的。这没有影响结果。

### 3.9 Cookie 会被服务器轮换

- **现象**：续期时服务器返回新的 `__Secure-next-auth.session-token.0/.1`（分块 Cookie），旧值会失效或被删除。
- **解决**：`mergeSetCookie` 合并更新，遇到空值或 `Max-Age=0` 就删除；值里含 `=` 的 base64 不截断；原子写回文件。有单元测试。
- **证据**：测试期间凭据文件的修改时间自己更新了。

### 3.10 单元测试抓到的 bug

- **现象**：中文回复里 `…/releases。`，全角句号被当成 URL 的一部分，生成 `…releases%E3%80%82`。
- **解决**：裸 URL 只匹配 ASCII 的 URL 字符。
- **说明**：没有测试，这个 bug 会在真实使用中悄悄出现。

### 3.11 运行中的进程不会加载新代码

- **背景**：之前改了模型，运行中的 MCP 进程仍是旧代码。
- **解决**：开关放在配置文件里，进程监听文件，变化时用 SDK 的 `enable()/disable()`，自动发 `tools/list_changed`。用真实 MCP 客户端验证：`dot off` 后工具消失（1 次通知），`dot on` 后恢复（2 次通知）。

## 4. 被实测推翻的设计假设

| 设计稿里的判断 | 实测 |
|---|---|
| Dot 没有已知公开接口，只能驱动网页 | 有一套可直接调用的 messaging 接口 |
| 直连需要处理浏览器指纹和校验令牌，成本高 | 目前不需要 Sentinel 令牌，Cloudflare 也没拦 |
| 推荐专用 Chrome + CDP 作为正式驱动 | 目前没有必要，暂缓 |
| 每次搜索新开一个聊天，避免污染 | 账号只有一个房间，做不到 |
| 回复可能是分阶段的进度消息 | 简单查询都是单条回复；仍保留结束标记以防万一 |
| 额度无限 | 仍未验证 |

这次的教训：**先用最小代价验证，再决定架构**。设计稿里“需要浏览器”的判断，如果当时就做一次只读的直连试探，能省掉不少篇幅。

## 5. 痕迹清单

**发到你的 Dot 的消息：共 7 条**（每条都有一条回复）

| # | 来源 | 内容 |
|---|---|---|
| 1、2 | 通过网页界面 | “接口测试 / 接口测试2，请忽略”，Node.js LTS、Python 版本 |
| 3 | 从 Node 直发 | “接口测试3，请忽略”，只回复 OK |
| 4 | `subpow dot search` | quick：Node.js LTS |
| 5、6 | 两个进程并发 | quick：火山方舟 Coding Plan、Python 版本 |
| 7 | `subpow dot search` | deep：Node.js 24 和 26 的 LTS 状态 |

后 4 条是带 `[API call — web search backend]` 规则的完整提示词，没有标“请忽略”。Dot 的电脑也被唤醒过一次（离线 → 已就绪）。

**本地新增文件**

- 代码：`server/lib/store.mjs`、`server/lib/dot.mjs`、`server/bin/subpow.mjs`、`server/tests/dot.test.mjs`；改动 `server/index.mjs`、`server/lib/queue.mjs` 等。
- 状态（仓库之外）：`~/.subscription-powers/config.json`、`dot-credentials.json`（均 0600），`dot.lock`（运行时）。
- 日志：`~/.cache/subscription-powers/calls.jsonl`。

**已清理**：导出的 HAR；CDP 会话与网络监听已断开；`/tmp` 里的探测脚本。仓库里搜不到 `eyJhbGciOi`、`__Secure-next-auth`、`cf_clearance`。

## 6. 借鉴 oh-my-pi：它怎么用 ChatGPT 接口做 Web Search

### 6.1 它的做法，和我们的区别

oh-my-pi 走的是 Codex 的 Responses 接口（`/backend-api/codex/responses`），身份是 OAuth（复用 Codex CLI 的 `client_id`），不是网页会话。我们走的是网页的 messaging 接口，身份是会话 Cookie。所以**协议层面的东西基本不能照搬**，能借鉴的是工程思路。

| 方面 | oh-my-pi | 我们现在 |
|---|---|---|
| 身份 | OAuth + refresh_token，令牌存数据库，惰性刷新 | 会话 Cookie 换 access token，惰性刷新（已实现） |
| 套餐/账号识别 | 解码 JWT 的 `chatgpt_plan_type`、`chatgpt_account_id` | 只用了账号 ID，**没用套餐** |
| 发出的身份头 | `originator: omp`、固定 `version: 0.159.0` | 原样复用浏览器抓到的头，**不会自己更新** |
| 版本漂移 | `scripts/check-spoofed-versions.ts`：对照上游最新版本，提前发现可能被拒绝的风险 | 无 |
| 错误分类 | 解析 SSE 里三种错误包装；按文本归类 429 / 401 / 403 / 504 / 500 | 按 HTTP 状态归类，较粗 |
| 重试 | 最多 5 次；`model_error / server_error / internal_error` 与“overloaded、temporarily”等文本可重试；429 按服务器给的延迟重试，总预算 5 分钟 | 不重试 |
| “真的搜索了吗” | 流里没出现 `web_search_call` 就报错，不把凭记忆的回答当搜索结果 | 无法看到工具调用，只要求至少有一个 URL |
| 凭据安全 | 官方 OAuth 令牌拒绝发往自定义端点 | 域名写死为 `chatgpt.com`，不可配置（已满足） |
| 额度 | 解析 `/backend-api/wham/usage` 的 5 小时、7 天窗口和 `limit_reached` | 无 |
| 实时流 | 读 SSE | 轮询（`live` 流没用） |
| 失败后的去向 | 候选链：失败就换下一个搜索源 | 返回错误，由调用方改用 `codex_web_search` |

### 6.2 这次核实到的、对我们最有用的两点

1. **令牌里有套餐字段，可用来精确检测 Pro 到期。** 我们的令牌 `https://api.openai.com/auth` 声明里有 `chatgpt_plan_type`，当前值是 `prolite`（oh-my-pi 的 `getTokenProfile` 也读这个字段）。现在的熔断要等连续失败 3 次才触发，而套餐变化在**下一次续期时**就能发现。
2. **页面本身就在调用 `/backend-api/wham/usage`。** oh-my-pi 用它读额度窗口。我们可以在 `status` 里展示，也可作为 Pro 状态的第二个信号。注意：这个接口描述的是套餐额度，Dot 消息是否计入还不清楚。

### 6.3 建议的后续改进（按优先级）

| 优先级 | 改进 | 借鉴自 | 说明 |
|---|---|---|---|
| P1 | **套餐变化即熔断**：每次续期解码 `chatgpt_plan_type`，与捕获时记录的值比较，变了（如 `prolite` → `plus`）就写入 `tripped_reason: plan_changed` | `getTokenProfile` | 不需要事先知道所有套餐名，只比较“有没有变” |
| P1 | **瞬时错误重试**：`dot_network`、5xx 退避重试 1–2 次；429 读 `Retry-After`，在预算内重试 | `CODEX_MAX_RETRIES`、`CODEX_RATE_LIMIT_BUDGET_MS`、可重试文本 | 现在一次网络抖动就返回失败，调用方要自己重试 |
| P2 | `status` 展示套餐与 `wham/usage` 的额度窗口 | `usage/openai-codex.ts` | 先弄清 Dot 消息是否计入 |
| P2 | **客户端版本漂移检测**：`oai-client-version` 是抓包时的前端构建号，会过期。写一个检查，看现在网页用的值是否变了，变了就提示重新抓取 | `check-spoofed-versions.ts` | 目前没有证据表明服务端校验它，但这是 oh-my-pi 明确在防的风险 |
| P2 | 改用 `live` 的 SSE 代替轮询 | oh-my-pi 的 SSE 读取 | 延迟更低、请求更少；要处理断线重连 |
| P3 | 错误分类更细：解析响应体里的错误码，而不只看状态码 | `extractCodexSseError` | 便于区分“套餐过期”“被限流”“被风控” |
| P3 | 搜索真实性：尝试从消息元数据里找工具调用线索（`inspector_url`、`message_metadata`） | `webSearchInvoked` | 目前只能靠“至少一个 URL”，无法确认真的搜索过 |
| P3 | 被强制校验时的后备：用页面的 `SentinelSDK.token()` 生成 | 无（我们自己的发现） | 即路线 2/3 的用途 |
| ✅ | 路线 3：`subpow dot capture` 自动抓取并导入登录态 | 无 | 已完成，见 §9 |

### 6.4 不适用于我们的部分

- OAuth 浏览器登录、设备码登录、refresh_token 刷新：我们没有这些，只有会话 Cookie。
- 请求体 zstd 压缩、`x-openai-internal-codex-residency` 区域头：是 Codex 后端的要求，messaging 接口没有观察到。
- `tool_choice: web_search` 强制搜索：messaging 接口是对话，没有这个参数，只能靠提示词。

## 7. 尚未验证的事项

- Pro 到期后的真实表现（只是推断：续期拿不到令牌，或接口 401/403/404 → 熔断）。
- “额度无限”：没有找到限额，也没有证据证明没有。
- Sentinel 令牌何时会被强制。
- 回复很长或需要多步研究时，Dot 是否会先发进度消息（结束标记与稳定等待是为此准备的，但没有遇到过）。
- 长期使用后，Dot 是否把这些搜索纳入记忆或改变行为。

## 8. 命令速查

```
node server/bin/subpow.mjs dot status                  # 开关、熔断、登录态到期、最近调用
node server/bin/subpow.mjs dot on | off | reset        # 开 / 关 / 清除熔断
node server/bin/subpow.mjs dot check                   # 健康检查：续期并读一条消息，不发送内容
node server/bin/subpow.mjs dot capture [--dry-run]     # 从日常 Chrome 自动抓取登录态（--dry-run 只验证不保存）
node server/bin/subpow.mjs dot auto-capture on | off   # 登录态失效时自动重抓
node server/bin/subpow.mjs dot import-har <文件>       # 手动：从 HAR 导入登录态
node server/bin/subpow.mjs dot search "问题" --mode deep --n 5   # 直接搜索（会发真实消息）
cd server && npm test                                  # 46 个单元测试（Dot 10 + 抓取 9 + Codex 直连 27）
```

## 9. 路线 3：用日常 Chrome 自动抓取登录态（2026-11-03 完成）

**做法**（`server/lib/dot-capture.mjs`）：经 chrome-agent-bridge 找到已登录的 `chatgpt.com/dots` 标签页 → 附加 CDP 调试器 → 只监听网络事件（不刷新、不发消息）→ 页面自己会定期发带令牌的请求（实测 14 秒内就有 `wham/usage` 等），把 `requestWillBeSent` 的头与 `requestWillBeSentExtraInfo` 里浏览器后加的 `cookie` 按 `requestId` 合并 → **立刻分离调试器** → 用抓到的登录态只读验证一次，通过才写入 `dot-credentials.json`。原始事件含机密，只在本进程内处理，不经过模型对话。

**踩到的点与结论**

| 问题 | 结论 |
|---|---|
| 页面空闲时不会发 `/messaging/rooms/...` 请求，抓不到房间号 | 房间号取现有凭据；都没有就调 `GET /backend-api/messaging/rooms`（未文档化，实测可用）。在空目录里从零抓取，房间号由这个接口自动发现 |
| 标签页地址末尾那串 32 位十六进制**不是**房间号 | 与已保存的房间号不同，不能拿来当房间号用 |
| `oai-client-version` 不一定出现在抓到的请求头里 | 页面 `<html data-build>` 属性与它完全相同（实测一致），作为后备来源 |
| 抓取失败时调试器不能留在用户的标签页上 | `finally` 里一定分离；测试覆盖了超时和找不到登录请求两种路径 |
| 验证不能弄坏现有凭据 | 先用内存里的新登录态只读请求一次（`readOnly` 不落盘），通过才保存；`--dry-run` 永不保存 |

**自动重抓**：`dot.auto_recapture`（默认关）。搜索遇到 `dot_unavailable` / `dot_blocked` 时，若开启且距上次重抓超过冷却期（默认 10 分钟），就重抓一次并重试同一个请求；重抓失败则原样返回原来的错误，照常计入熔断。重抓成功会清掉因登录态问题造成的熔断。

**实测**（临时状态目录）：①故意把 Cookie 和令牌改坏，关闭自动重抓 → `dot_unavailable`（0.7 秒）；②同样改坏，开启自动重抓 → 约 21 秒返回 3 条正确结果，响应带 `recaptured: true`。

**代价与限制**：抓取期间 Chrome 会短暂显示“正在被调试”提示；需要 chrome-agent-bridge 在本机且有一个登录着的 Dot 标签页（`--open` 可用记住的 `dot_url` 开后台标签页，未做实测）；登录态因“退出登录/到期”彻底失效时，Dot 页面本身也未登录，抓取会报 `dot_capture_no_auth`。
