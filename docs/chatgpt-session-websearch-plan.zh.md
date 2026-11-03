# 固定 ChatGPT 网页会话做 Web Search：分析与方案

> 2026-11-03。想法：用户必须给 MCP 指定**一个** ChatGPT 网页版会话（session）网址，之后所有联网搜索都在这个固定会话里进行，用 Instant 级别的快模型、低思考，让它搜完把链接给出来。思路与 Dot 搜索相同——直接调网页的接口。
>
> 本文起初是分析；随后做了 P0 验证（**第 12 节**），再按"驱动页面"路线实现为正式功能 `chatgpt_web_search`（**第 13 节**，默认关闭）。想知道现在是什么样，直接读第 13 节。没有写任何功能代码。第 3 节的事实来自只读探查，第 11 节列出了只读阶段做过的每个请求，第 12 节列出了验证阶段做过的每个动作。凡是没验证的，都标了"未验证"。

## 1. 结论

| 问题 | 回答 |
|---|---|
| 这个思路以前讨论过吗？ | **本项目没有。** 仓库的文档里没有出现 GPT-4o 或"固定网页会话"。最接近的是：`analysis-and-plan.zh.md` §2 否决了"复用令牌直打后端"（后来我们对 Dot 和 Codex 破例做了）；`dot-websearch-design.zh.md` 里猜过"ChatGPT 网页聊天请求常带校验令牌"。你记得的可能来自别的项目或别的会话，我没法确认。 |
| 开源项目有这么做的吗？ | 有一类项目专做"把 ChatGPT 网页变成 API"（我凭记忆想到 chat2api、gpt4free、pandora 一类，**没有核实当前状态**）。它们共同的难点就是下面的 Sentinel 校验，而且需要持续追着网页改。 |
| 能直接调接口吗？ | **能读，发送要过关。** 读会话、读模型列表、读结构化的搜索来源都是普通带登录态的 GET，今天实测通了。但**发消息**的接口要先过 Sentinel：`chat-requirements` 实测返回 `proofofwork`、`turnstile`、`so`（会话观察者）三项**全部 required**。这和 Dot 不同——Dot 的消息接口不需要任何校验令牌。 |
| 能指定 GPT-6 Instant 吗？ | **应该能。** 账号的模型列表里有 `gpt-6-instant`（标题 GPT-6，`reasoning_type: none`），这就是网页上 "GPT-6 + Instant" 对应的模型标识（**由列表推断，未发消息验证**）。GPT-4o 已经不在你的模型列表里了，不用考虑。 |
| 值不值得做？ | **P0 验证已做（第 12 节）：混合路线按原设想走不通；驱动页面这条路走通了。** 驱动页面比 Dot 慢一点、依赖 Chrome 开着那个标签页，但结果是结构化的、条数多，而且不依赖 Pro。是否继续做成正式功能，等你定。 |
| 会话网址存哪？ | 存到 `~/.subscription-powers/config.json`，见第 6 节。 |

## 2. 你给的会话，实测了什么

- 网址：`https://chatgpt.com/g/g-p-<项目id>-only-for-local-agent-websearch/c/<会话id>`
  - `g-p-…` 是一个**项目**（project，接口里叫 gizmo），标题 `only-for-local-agent-websearch`；`c/…` 后面是会话 id。
- 这个会话**存在、没归档**，里面已经有过一次搜索：1 条用户消息、5 条助手消息、1 条工具消息，用的模型标识是 `gpt-6`，默认模型也是 `gpt-6`。
- 它发生过搜索：工具消息 `web.run` 带 `search_result_groups`，**一次搜索返回 20 条、另一次 35 条来源**，每条是 `{type, url, title, snippet, ref_id, pub_date, attribution}`。

这一点很重要：**网页的搜索来源是结构化的，带标题、摘要和发布日期**，不用让模型自己列链接再解析文本。对比 Codex 的 `web_search`（来源只有 url，标题要靠引用补）和 Dot（只能靠提示词让模型吐 JSON），这里的 quick 可以直接返回结构化字段，而且条数多得多（你之前问过"为什么才 3 条"）。

## 3. 今天实测到的事实

### 3.1 模型列表（`GET /backend-api/models`）

账号可见的模型（只列标识、标题和思考类型）：

| 标识 | 标题 | 思考类型 | 说明 |
|---|---|---|---|
| `gpt-6-instant` | GPT-6 | `none` | **候选：Instant，不思考** |
| `gpt-6` | GPT-6 | `auto` | 自动决定；你的会话用的就是它（会话里出现了"思考"消息） |
| `gpt-6-thinking` | GPT-6 | `reasoning` | 思考 |
| `gpt-6-t-mini` | GPT-6 | `reasoning` | 名字像"思考 mini"，含义未验证 |
| `gpt-6-mini` | GPT-6 | `none` | 含义未验证 |
| `gpt-5-6-instant` | GPT-5.6 Sol | `none` | 上一代的 Instant |
| `gpt-6-pro` / `gpt-5-6-pro` | GPT-6 Pro / GPT-5.6 Pro | `pro` | Pro 专属 |
| `gpt-6-sol-wm`、`gpt-6.1-sol-wm`、`gpt-6-luna-wm`… | GPT-6 Sol / 6.1 Sol / Luna… | `reasoning` | 名字带 `-wm`，用途未验证，先不碰 |
| `research` | Deep Research | `none` | 深度研究 |

`default_model_slug` 是 `gpt-6`。**没有任何 `gpt-4o`。**

你截图里的界面：模型下拉里是 "GPT-6 ✓ / GPT-5.6 Sol"，输入框旁的药丸是 "Instant"。我的推断是：下拉选的是模型家族 GPT-6，药丸选的是思考程度，选 Instant 时实际用的标识就是 `gpt-6-instant`。**这个对应关系需要抓一次真实发送请求来确认**（第 9 节 P0）。

### 3.2 读会话（`GET /backend-api/conversation/<id>`）

普通带登录态的 GET，200。返回整棵消息树 `mapping`，节点里有模型标识、`search_result_groups`、`content_references`（引用位置，类型如 `sources_footnote`）。**读结果不需要任何校验令牌**，所以"发送完成后从会话里读结构化来源"这条路是通的。

### 3.3 发送要过 Sentinel（`POST /backend-api/sentinel/chat-requirements`）

HTTP 200，返回 `token`、`persona: "chatgpt-paid"`，以及三项要求：

| 项 | 实测 |
|---|---|
| `proofofwork`（算力题） | **required** |
| `turnstile`（Cloudflare 人机校验令牌） | **required** |
| `so`（会话观察者令牌） | **required** |

也就是说，普通会话的发送接口需要这些令牌随请求一起带上（具体放在哪几个请求头里、格式如何，我**没有抓过**，不凭印象写）。Dot 的消息接口不需要，所以之前直连很顺。

### 3.4 页面自己能生成这些令牌

在你已登录的标签页里，页面暴露了 `window.SentinelSDK`，有 5 个成员：`init`、`requirementsToken`、`sessionObserverToken`、`timing`、`token`（`token` 接受 1 个参数）。页面还加载了 `…/sentinel/<构建号>/sdk.js`。**我只检查了它存在，没有调用任何一个函数。** 这意味着：令牌可以让页面自己的脚本来生成，我们不必在 Node 里复刻算力题和人机校验。

## 4. 与 Dot 的对比

| | Dot（已完成） | 固定网页会话（本方案） |
|---|---|---|
| 需要的订阅 | ChatGPT Pro（将来可能失效） | **任意能用 GPT-6 的账号**，不依赖 Pro |
| 发送接口的校验 | 无 | Sentinel 三件套（算力题 + 人机 + 观察者），**必须过** |
| 来源 | 文本里的链接，靠提示词让模型吐 JSON | **结构化**：标题、URL、摘要、日期，一次 20–35 条 |
| 额度 | 称"无限"（未验证） | 计入账号的 GPT-6 消息额度（**未验证**；Instant 通常限额宽松，但没查过） |
| 对话归属 | 账号唯一的 Dot 房间 | 你指定的固定会话，在你的侧边栏里可见 |
| 被盯上的风险 | 小众接口 | **网页聊天接口是自动化检测的主战场**，风险更高 |
| 维护成本 | 低 | 高：校验随网页版本变，要么跟着改要么借页面脚本 |

## 5. 实现路线

### 路线 I：纯 Node，自己算令牌

照开源项目的做法，在 Node 里复刻算力题和 Turnstile 的求解。
- 优点：不需要浏览器常开。
- 缺点：Turnstile 令牌来自页面下发的一段混淆字节码，要自己写解释器；`so` 令牌是新增的；每次网页改版都可能失效。**这是维护成本最高的一条，不推荐。**

### 路线 II：混合——令牌借页面生成，请求由 Node 发（**推荐先验证**）

经 chrome-agent-bridge 在固定会话的标签页里调用 `SentinelSDK`（`requirementsToken` / `token` / `sessionObserverToken`）拿到令牌，Node 带着令牌发 SSE 请求，再用普通 GET 读结构化来源。
- 优点：不复刻任何校验逻辑；令牌由页面自己的最新脚本生成，网页改版后通常不用跟着改；请求体、模型、父消息都在 Node 里可控。
- 缺点：需要 Chrome 开着那个标签页、bridge 在线；**未验证**：令牌是否能在页面之外的请求里使用（可能绑定 IP、UA、TLS 指纹、页面会话）。

### 路线 III：驱动页面——像用户一样在输入框里发

bridge 往固定会话页面的输入框里填提示词并点发送，页面自己完成所有校验；Node 只负责读结果（普通 GET）。
- 优点：**最稳**，校验、请求头、请求体格式全由页面处理，网页怎么改都跟着走。
- 缺点：依赖页面界面元素（改版会坏）；需要标签页开着；会操作你的浏览器界面（要注意不抢焦点）；每次发送慢几秒；页面上同时有人在用时会互相干扰。

### 推荐顺序

**P0 已验证：II（SDK 令牌 + Node 发送）被拒，III（驱动页面）可行（第 12 节）。** 所以现在的推荐是 III；I 不做；II 只有在能拿到页面真正使用的那套令牌时才值得重试。

## 6. 会话网址的配置（回答"存到 `~/.subscription-powers` 行不行"）

可以，而且应该放在那里：该目录已经是 0700，里面的 `config.json` 已经是 0600，开关、熔断、顺序都在这儿，热加载机制现成。

**配置项**（放进 `config.json` 的 `chatgpt_web` 块，与 `dot`、`codex_api` 并列）：

```jsonc
"chatgpt_web": {
  "enabled": false,                 // 人工开关，默认关
  "tripped": false, "tripped_reason": null, "consecutive_failures": 0, "trip_after": 3,   // 熔断，同其它后端
  "session_url": null,              // 用户必须指定的固定会话网址
  "conversation_id": null,          // 从网址解析
  "project_id": null,               // 从网址解析（g-p-… 部分，可选）
  "model": "gpt-6-instant"          // 可改；校验时必须在账号的模型列表里
}
```

**规则**
- **没配置就报错，不猜、不自动新建会话**：返回 `chatgpt_web_no_session`，消息里写明怎么配置（你提的要求）。也不会悄悄用别的会话。
- 命令：`subpow web session set <url>`。设置时解析网址（`/c/<uuid>`，可带 `/g/g-p-…` 项目前缀），并**当场验证**：`GET /backend-api/conversation/<id>` 能读到、没归档、属于当前账号，且 `gizmo_id` 与网址里的项目一致，否则拒绝保存。
- `subpow web session show / clear`；环境变量 `SUBPOW_CHATGPT_SESSION_URL` 可覆盖（方便多机或测试）。
- 网址本身不是令牌，但会话 id 属于私有信息，所以仍放 0600 文件里，不进日志、不进仓库。
- 登录态（Bearer、Cookie）复用 Dot 已经抓取的那份（同一个账号、同一个浏览器），不另存；`dot capture` 也顺带刷新它。需要的话把 `dot-credentials.json` 改名为通用的登录态文件——这是实现时再决定的小事。

## 7. 请求设计

**模型与思考**：默认 `gpt-6-instant`；用户可在配置里改成 `gpt-6` 或 `gpt-6-thinking` 来换取更深的搜索。是否真的"低思考"由模型标识决定，请求里没有单独的思考强度字段（**未验证**）。

**让它搜，而且只搜**：提示词沿用 Dot 的做法（只用内置联网搜索、不用别的工具、不记忆、不提问）。网页还有"强制搜索"的开关（请求里的 `system_hints`，我印象里叫 `search`，**未验证、需要抓包确认**），能用就用，比靠提示词可靠。

**怎么避免固定会话越聊越长**：每次搜索都在同一个会话里，历史会不断累积，既污染上下文、又让 `GET conversation` 越来越大。两个做法：
1. **每次从固定"锚点"消息分叉**：请求里的 `parent_message_id` 永远指向会话里同一条老消息，这样每次搜索是从同一个起点长出的新分支，**模型看不到之前的搜索**，上下文不会累积；会话内容只在树里横向增加。（网页界面只显示当前分支。）**未验证**：分叉发送是否被接受、"当前分支"会不会被我们的请求改变、对你在网页里正常看到的内容有什么影响。
2. 退而求其次：不分叉，接受上下文累积，隔一阵让用户 `subpow web session set` 换一个新会话。

**读结果**：我们自己生成用户消息的 id，发送完成后 `GET conversation`，沿着这条消息往下找到属于它的助手 / 工具节点：
- **quick**：直接取 `search_result_groups` 的条目返回 `{title, url, summary(=snippet), published(=pub_date)}`，**不依赖模型吐 JSON**，条数 20–35，按 `max_results` 截断、去重、去掉 `utm_source=chatgpt.com`。
- **deep**：取最终助手消息文本作答，来源取 `content_references` 与 `search_result_groups`。
- 与其它后端一样，要求"这条回复里**确实发生过搜索**"（有 `web.run` 工具节点 / `search_result_groups`），否则判为 `no_search`，避免模型凭记忆作答。

**串行**：复用 Dot 的跨进程文件锁思路（锁文件换名），同一个固定会话同一时刻只有一个请求。

## 8. 开关、熔断、统一入口

- 作为第四个后端 `chatgpt_web` 接入统一的 `web_search`；工具 `chatgpt_web_search` 热开关，行为与 `dot_web_search` 一致。
- 默认顺序：先放在 Codex 直连之后、Codex CLI 之前，即 `dot` → `codex_api` → `chatgpt_web` → `codex_cli`，这样不改变现有行为。要不要提到前面，等额度和风险实测之后再定。
- **计入熔断**：Sentinel 被拒（令牌校验失败）、401/403、Cloudflare 拦截、会话不存在或被归档/删除、模型不在列表里。**不计入**：网络、限流（429）、5xx、超时。
- 套餐/账号变化：绑定开启时的套餐与账号，变了立即熔断（同 Codex 直连）。
- 用户没配会话 → `chatgpt_web_no_session`，**不计入熔断**，统一入口会直接跳过这个后端并写明原因。

## 9. 分阶段计划

| 阶段 | 做什么 | 退出条件 |
|---|---|---|
| **P0 验证（先做）** | ① 抓一次**真实发送**的请求：在固定会话页面里发一条消息，同时用 bridge 记录请求头与请求体（只在本进程里处理，不进对话）。确认：接口路径、模型字段、`system_hints`、`parent_message_id`、Sentinel 令牌放在哪几个请求头。② 用 `SentinelSDK` 生成令牌，从 **Node** 发同样的请求，看是否被接受（路线 II 的生死线）。③ 在页面里把模型切到 Instant，对比请求体里的模型标识。④ 试"分叉"发送。 | 得出路线 II 能否成立；知道请求结构 |
| P1 | 实现 `lib/chatgpt-web.mjs`（配置解析与验证、令牌获取、SSE 读取、结构化来源解析）+ 单测（假 fetch、假 bridge） | 离线测试全过 |
| P2 | 工具 `chatgpt_web_search`、`subpow web …` 命令、热开关、熔断、并入统一入口 | 实测 quick / deep、热开关、并发不串线 |
| P3 | 失效自愈：令牌获取失败时的处理、`dot capture` 同步刷新登录态 | 同 Dot 路线 3 的自愈测试 |

P0 需要**发真实消息**：会在你指定的固定会话里留下 1–3 条测试消息（这个会话本来就是专给搜索用的）。**开始之前我会先征得你同意**，我今天没有发任何消息。

## 10. 风险与未验证

- **服务条款与账号风险**：用自动化向网页聊天接口发消息，比 Dot 更容易被识别；Sentinel 本身就是为了拦这类行为。后果可能是限流、要求重新验证，严重时影响账号。默认关闭、可一键关闭、熔断，是缓解而不是消除。
- **Sentinel 在页面之外是否有效**：令牌可能绑定 IP、UA、TLS 指纹或页面会话，**这是路线 II 最大的未知**。
- **额度**：搜索消息计入账号的 GPT-6 消息额度，Instant 的限额没查；与 Dot 的"无限"不同。
- **污染你的账号**：每次搜索都是你侧边栏里这个会话的一条消息；项目里的指令/记忆可能影响搜索行为（你这个项目叫 only-for-local-agent-websearch，应该是干净的，但未检查它的项目指令）。
- **接口无承诺**：字段、请求头、模型标识随时会变。表现应是熔断关闭，而不是静默返回错误结果。
- **模型标识含义**：`gpt-6-instant` 就是网页上的 "GPT-6 + Instant"，只是由列表推断。
- **GPT-4o**：不在你的模型列表里，本方案不涉及。

## 11. 今天做过的请求（只读，没发任何消息）

| 请求 | 目的 | 副作用 |
|---|---|---|
| `GET /backend-api/models?history_and_training_disabled=false` | 看可用模型 | 无 |
| `GET /backend-api/conversation/<会话id>` | 看会话结构 | 无（只读；脚本里只打印字段名、数量和长度，没有打印任何消息内容） |
| `POST /backend-api/sentinel/chat-requirements`（空请求体） | 看发送要不要校验 | 服务端会签发一个一次性令牌，**没有发送消息**；响应里只读了 `required` 标志 |
| CDP `Runtime.evaluate`：检查 `window.SentinelSDK` 是否存在及成员名 | 看页面能不能生成令牌 | 附加了约 1 秒调试器后立即分离；**没有调用 SDK 的任何函数** |

登录态用的是 Dot 已保存的那份，全程以只读方式使用（没写回文件）。

## 12. P0 验证结果（2026-11-03，已在你的固定会话里发了测试消息）

### 12.1 做了什么

| 动作 | 结果 |
|---|---|
| 经 bridge 驱动页面发送，共 **3 条**测试消息（"搜索一下 Node.js 当前 LTS…"、"再搜一次：Python…"、"第三次测试：Go…"）。其中第 2 条是我脚本里一处补丁没打上、旧脚本又跑了一遍造成的，多发了一条 | 3 条都成功，页面自动联网搜索并回答 |
| 同时记录了页面发出的真实请求（请求头只记名称与长度，请求体长字符串折叠） | 见 12.2 |
| 混合路线测试 ①：令牌由页面 SDK 生成，**Node** 发 `POST /f/conversation` | **403** `Unusual activity has been detected from your device` |
| 混合路线测试 ②：同样的令牌和请求，改由**页面自己的 fetch** 发（排除 Node 的 TLS/请求头差异） | **同样 403** |
| 之后只做了一次只读的 `GET`，确认账号和会话读取仍正常；**没有再重试发送** | 正常 |

我超出了第 9 节写的"1–3 条"之外的两次**被拒绝的请求**，它们没有产生消息，但"Unusual activity"是风控信号，所以我停手了，没有继续试。

### 12.2 页面真实的发送流程（抓包所得）

一条消息发送前，页面按顺序做：

1. `POST /backend-api/f/conversation/prepare`（会话 id、模型、`parent_message_id`、项目 id 等）→ 返回 `conduit_token`，后面作为请求头 `x-conduit-token`。
2. `POST /backend-api/sentinel/chat-requirements/prepare`，请求体 `{p: <约 700 字符的 gAAAAA… 令牌>}` → 返回 `prepare_token`，以及三个要解的题：`turnstile.dx`（约 3 万字符的字节码）、`proofofwork {seed, difficulty}`、`so.collector_dx / snapshot_dx`（两段约 2.5–3 万字符的字节码）。
3. `POST /backend-api/sentinel/chat-requirements/finalize`，请求体 `{prepare_token, proofofwork, turnstile}` → 返回 `token`，**有效期约 540 秒**。
4. `POST /backend-api/f/conversation`（SSE），请求头带：`openai-sentinel-chat-requirements-token`（来自 finalize）、`openai-sentinel-proof-token`、`openai-sentinel-turnstile-token`、`x-conduit-token`、`chatgpt-project-id`、`x-oai-turn-trace-id`、`oai-echo-logs`，Bearer 与 Cookie。页面还会**提前为下一条消息预取**一套（所以这一套的 prepare/finalize 出现在发送请求之后）。

请求体的主要字段：`conversation_id`、`action: "next"`、`model`、`parent_message_id`、`conversation_mode: {kind: "gizmo_interaction", gizmo_id}`、`gizmo_id`、`messages[0]`（`author.role: "user"`、`content.parts: [文本]`、自生成的 `id`、`create_time`）、`supported_encodings: ["v1"]` 等。

### 12.3 关键发现

1. **混合路线（SDK 令牌）按原设想不成立。** `SentinelSDK.token('conversation')` 能生成令牌（返回 JSON：`p`（证明）、`t`（人机）、`c`、`id`、`flow`），内部走的是 `POST /sentinel/req`；但会话页面实际用的是上面的 **prepare → finalize** 流程，由应用自己的代码完成，**没有通过 `SentinelSDK` 暴露出来**。拿 SDK 的令牌填进那三个请求头，服务端当场拒绝（Node 和页面里都一样，所以**不是** TLS 指纹或请求头差异的问题，是令牌不对）。
2. **没验证到的**：如果拿到页面真正使用的那套令牌，从 Node 发送是否被接受。要做到只能解 `turnstile.dx`、`so.*_dx` 的字节码，也就是路线 I（自己复刻校验），或者深入应用的打包代码去找它的内部入口——两者都是维护成本最高、也最像规避校验的做法，**我不建议做**。
3. **驱动页面（路线 III）可行，而且很快。** 在输入框填文字、按回车，页面自己完成全部校验与发送。实测：发送后 **5.4–7.6 秒**搜索结果节点就出现在会话里；来源数 12、12、2。读取靠普通 `GET /backend-api/conversation/<id>`，不需要任何令牌。
   - 输入框是 `div[role="textbox"][aria-label="询问 ChatGPT"]`（ProseMirror）；发送按钮在填字后才出现，直接发回车键事件即可。界面文字是中文，改了语言选择器会变，**这是路线 III 的脆弱点**。
4. **模型选择的问题。** 页面选着 "Instant" 时，发送请求体里的 `model` 仍是 `"gpt-6"`，请求体里**没有单独的思考强度字段**；回复节点的 `resolved_model_slug` 也是 `gpt-6`，且出现了"思考"节点（耗时约 3 秒）。也就是说：
   - "Instant" 这个药丸**没有**换成 `gpt-6-instant`，它的作用在请求体里看不出来（可能通过别的方式，例如 `x-conduit-token` 里，未验证）。
   - **路线 III 下无法由我们指定模型**，用的是页面当前的选择。要换就得操作界面（点药丸），更脆弱。
   - `gpt-6-instant` 能否被接口接受没有测成（因为发送被 403 了）。
5. 回复里除了正文还有 `search_result_groups`，**quick 可以直接用它**（标题、URL、摘要），不依赖模型文字；搜索结果节点比回答正文更早出现，可以在回答还没写完时就读（如果只要来源）。
6. 每次发送，会话里会多出一整串节点（用户消息、助手、工具、思考…），本次三条测试后会话共 4 条用户消息。**固定会话会持续增长**，第 7 节的"分叉"做法对路线 III 不适用（界面总是接在当前分支末尾）。

### 12.4 对方案的影响

| 项 | 结论 |
|---|---|
| 路线 I（Node 自己解校验） | 不做 |
| 路线 II（SDK 令牌 + Node） | **已证伪（用 SDK 的令牌）**；只有拿到页面真正的令牌才可能成立，不建议 |
| 路线 III（驱动页面） | **可行**。代价：必须开着 Chrome 和那个标签页；依赖界面元素；不能指定模型；会话越聊越长；一次只能一条（串行，用锁） |
| 与 Dot 比 | Dot 仍是更好的主力（不过校验、不碰界面、不污染可见会话）。网页会话适合作为 **Pro 失效后的接班后端**——它不依赖 Pro，而且来源是结构化的 |
| 账号风险 | 被拒的两次请求已经触发过"Unusual activity"提示。路线 III 发的是页面自己的合法请求，风险低于自己拼请求，但**仍是自动化**，并且仍是 ToS 灰区 |

### 12.5 如果继续做路线 III，需要你决定

1. **要不要做**：它是 Dot 的后备，不是替代。如果你的 Pro 暂时不会失效，可以先不做，只保留这份验证结论。
2. 模型：接受"用页面当前选择的模型"（你在页面里把它调到 Instant 就行，我们只在返回里记录实际用了哪个模型），还是要我们去点界面（更脆弱）。
3. 会话越来越长：定期换新会话（`subpow web session set`），还是由我们在工具里提示。
4. Chrome 必须开着：没开时直接报 `chatgpt_web_no_tab`，不尝试自己起浏览器。

## 13. 实现结果（2026-11-03，已完成，默认关闭）

### 13.1 做了什么

| 文件 | 内容 |
|---|---|
| `server/lib/chatgpt-web.mjs` | 后端本体：会话网址解析与验证、经 bridge 驱动页面发送、轮询会话读结果、结构化来源、熔断 |
| `server/lib/lock.mjs` | 从 `dot.mjs` 抽出的通用跨进程锁（`withLock(name, …)`）；Dot 与本后端各用各的锁文件 |
| `server/lib/store.mjs` | 新增 `chatgpt_web` 配置块；搜索后端增加 `chatgpt_web`，默认顺序 `dot → codex_api → chatgpt_web → codex_cli` |
| `server/lib/search.mjs` / `server/index.mjs` / `server/bin/subpow.mjs` | 并入统一入口；工具 `chatgpt_web_search`（热开关）；命令 `subpow web …` |
| `server/tests/chatgpt-web.test.mjs` | 15 个离线测试（假 bridge + 假会话）；全套现为 61 个 |

### 13.2 与第 5–9 节计划的差别

| 项 | 计划 | 实际 |
|---|---|---|
| 路线 | 先验证 II | II 被证伪，实现 III（驱动页面） |
| 会话网址 | `subpow web session set <url>`，没配置就报错 | 一致。保存在 `~/.subscription-powers/config.json` 的 `chatgpt_web.session_url`；环境变量 `SUBPOW_CHATGPT_SESSION_URL` 可覆盖；设置时当场验证（能读到、没归档、项目一致）；没配置返回 `chatgpt_web_no_session` 且**不计入熔断** |
| 模型 | 默认 `gpt-6-instant` | **无法指定**，用页面当前选择；返回里带 `model`（实测都是 `gpt-6`） |
| 分叉防止会话变长 | 每次从同一条旧消息分叉 | 不可行（界面总接在当前分支末尾），改为接受增长，列入待办 |
| 登录态 | 复用 Dot 那份 | 一致（`dot-credentials.json`，只用于 GET） |
| 套餐/账号绑定熔断 | 计划里提到 | **没做**；熔断只看失败类型 |
| 失效自愈 | P3 | **没做**；登录态失效时报 `chatgpt_web_unauthorized`，用 `subpow dot capture` 刷新 |

### 13.3 流程

1. 读固定会话（验证没归档、项目一致）→ 经 bridge 列标签页，找地址里含该会话 id 的页面；没有则 `chatgpt_web_no_tab`。
2. 附加调试器：找到输入框（按结构 `div.ProseMirror[contenteditable]`，不依赖界面文字）→ **草稿非空则拒绝** → 填入单行提示词（带随机结束标记 `[[END:xxxxxx]]`）→ 回车 → 立即分离调试器。
3. 每 2 秒读一次会话，先等"含本次标记的用户消息"出现（25 秒内没出现 → 清掉填进去的字、报 `chatgpt_web_send_failed`），再等这一轮结束。
4. quick：直接取 `search_result_groups` 的条目（去重、去 `utm_source`、合并补全摘要和日期）；deep：取回答文本 + 来源。要求这一轮里确实发生过搜索，否则 `chatgpt_web_no_search`。

### 13.4 实测中发现并修掉的问题

| 现象 | 原因与处理 |
|---|---|
| quick 的摘要全是空的 | 同一个网址在**工具节点**（无摘要）和**助手节点**（有摘要和日期）各出现一次，去重时留下了先出现的空条目。改为合并补全 |
| `published` 是一串整数 | 时间戳（秒）。转成 `YYYY-MM-DD` |
| deep 的回答读成 `<escape></escape>` | 真实结构是：回答在倒数第二条 `end_turn` 节点里，末端叶子只是一条 `<escape>[[END:…]]</escape>` 的收尾；页面还会把结束标记包进 `<escape>`。改为"取最后一条清理后非空的回答"，完成与否看末端 |
| 担心拿到前言就返回 | 页面会先写一条前言（也是 `end_turn`）再写正式回答，前言在正式回答出现前同样是叶子。规则：末端含结束标记才算确定完成，否则等内容连续 3 次轮询不变。有测试覆盖，并做过变异检查（把 3 改成 1，该测试会失败） |
| 读会话偶发 `ECONNRESET` | 瞬时网络问题（紧接着同一请求恢复）。读会话对网络类错误重试 3 次；网络错误本来就不计入熔断 |
| 回答里有 `<Cite ref="…"/>` | 引用标记，清理掉 |

### 13.5 实测

| 项 | 结果 |
|---|---|
| quick | 14–27 秒；12 条左右来源；`model: gpt-6` |
| deep | 约 15 秒；回答正确（Go 1.27.3，与官方来源一致）并附来源 |
| 两个进程同时搜索不同主题 | 第二个在锁上等了 16 秒再运行 11 秒；两边结果各对各的主题，没有串线 |
| MCP 端到端（临时状态目录） | 默认工具不可见 → `web on` 在没有会话时被拒 → 设置会话 → 开启后 2 秒内工具出现（1 次 `list_changed`）→ 经统一入口 `web_search`（`backends:["chatgpt_web"]`）成功 → `web off` 后工具消失（累计 2 次通知） |
| 默认关闭 | 你本机的真实配置：`enabled:false`，会话已设置；运行中的 MCP 要重启后才有这个代码 |

实现与验证期间，本后端在你的固定会话里发了 **8 条**真实消息（会话里以 `[API call` 开头的用户消息，数量由会话本身核对）；加上你原有的 1 条和 P0 阶段的 3 条，会话里现在共 12 条用户消息。

### 13.6 已知限制

- **Chrome 必须开着该会话页面且保持可见**。后台标签页下输入和回车是否可靠**没有验证**（代码在发送失败时会提示标签页在后台）。
- **用页面当前选的模型**；"Instant"药丸在请求里看不出效果，没法验证它是否真的更快更省。
- **固定会话持续增长**：每次搜索留下一整串节点，读会话的响应会越来越大。
- 页面输入框的定位依赖 ProseMirror 结构；ChatGPT 改版可能让它失效，表现是 `chatgpt_web_ui_changed`，连续 3 次熔断。
- 额度：搜索消息计入账号的消息额度，没查限额。
- 登录态失效时没有自动重抓（Dot 有，这个没做）。
