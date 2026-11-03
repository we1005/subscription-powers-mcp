# 并行搜索失败与搜索开销分析

> 2026-10-24。背景：另一个 Claude Code 会话（项目 `/Volumes/zhitai-7100/agent…`）并行调用 `codex_web_search` 时出现失败、长时间卡住的现象。本文是**只读静态分析**的结论：没有启动或重启 MCP，也没有动运行中的进程。依据是代码、客户端日志、对话记录和 Codex 日志库。

## 0. 结论

| 现象 | 实际原因 |
|---|---|
| 一次搜索报 `codex_internal_error` | **网络问题**：06:45–06:57Z 这台机器上所有 codex 进程都连不上 `chatgpt.com`，不是 MCP 并发导致 |
| 很多结果显示 `still running after 120s … moved to the background` | **不是失败**。这是 Claude Code 的机制：MCP 调用超过 120 s 就转到后台，完成后再通知结果。日志显示这些调用最后都成功了 |
| “并行”搜索特别慢 | 实际是**一个接一个**执行的：服务端每个后端只有一条串行队列，Claude Code 往同一个 server 发调用也是一个一个发。每次搜索要 1–4 分钟 |
| 每次搜索都很贵、很慢 | 每次都启动一个完整的 Codex 代理会话，用用户默认的 `gpt-6-sol` + `high` 推理强度，并加载插件、MCP、模型列表等与搜索无关的东西 |

## 1. 唯一一次真实失败

客户端日志：`~/Library/Caches/claude-cli-nodejs/-Volumes-zhitai-7100-agent----/mcp-logs-subscription-powers/2026-10-22T16-38-56-502Z.jsonl`

- 2026-10-23 06:49:47Z 发起 `codex_web_search`，**264 s 后失败**。前面排着另一个调用，所以实际从 06:51:18 开始运行，跑了约 3 分钟。
- 返回 `{"ok":false,"code":"codex_internal_error","message":"codex exited with code 1"}`，`errors` 是两轮 `Reconnecting... 1/5 … 5/5 (workspace routing discovery failed)`。
- stderr 末尾：
  - `failed to refresh available models: request timed out`
  - `http/request failed: error sending request for url (https://chatgpt.com/backend-api/ps/mcp)`

Codex 日志库 `~/.codex/logs_2.sqlite`（只读、`immutable=1` 打开）06:45–06:57Z 的情况：

- 这段时间有 **11 个** codex 进程在运行：一个长期开着的 Codex 界面会话、一个长进程，外加一个**每分钟 :48 秒启动一次**的短进程。
- 这些进程**全部**报相同的网络错误：`list_models … request timed out`，`ps/plugins/*` 和 `plugins/featured` 请求 `error sending request`，界面会话里 `account/rateLimits/read failed`。
- 本机所有流量都走本地代理 `HTTPS_PROXY=http://127.0.0.1:7897`。

→ 判断：代理节点或 OpenAI 侧在这段时间短暂不可用，我们的调用正好赶上。调用方随后改用 `claude_web_search` 补搜，成功了。

## 2. 为什么“并行”变成了排队

1. **服务端**：`server/lib/queue.mjs` 中的 `serial('codex', …)` 让同一个 MCP 进程里的 codex 调用**严格串行**执行。
2. **客户端**：从日志看，同一批 3–5 个 `tool_use` 在对话记录里时间戳相同，但 MCP 日志里的 `Calling MCP tool` 是依次出现的，下一个总是在上一个完成或转入后台（120 s）时才发出。
3. **队列只在单个进程内有效**：每个 Claude Code / mirasim 会话都会启动**自己的** MCP server 进程。所以不同会话之间，codex 子进程仍然会同时运行，队列管不到。
4. 实测耗时（10-23 两批）：1 分 19 秒、1 分 50 秒、2 分 5 秒、2 分 7 秒、2 分 57 秒、3 分 31 秒、4 分 0 秒。5 个“并行”搜索加起来要 10 分钟以上。
5. 超时计时从 codex 真正启动时开始（`runTask` 在 `serial` 内部），排队时间不算。但返回结果里没有排队时间，调用方看不出时间花在了哪里。

## 3. 每次搜索为什么又慢又贵

`server/lib/codex.mjs` 中的 `webSearch()` 调用 `codexExec` 时**没有传 `model`**，所以命令行里没有 `-m`，完全沿用 `~/.codex/config.toml`：

```toml
model = "gpt-6-sol"
model_reasoning_effort = "high"
```

另外，`codex exec` 每次都会加载完整的用户配置。Codex 日志里每次启动都能看到：

- `codex_models_manager` 联网刷新模型列表；
- `codex_core_plugins` 请求 `ps/plugins/installed`、`ps/plugins/list`、`plugins/featured`、`ps/plugins/suggested`；
- 连接 ChatGPT 的 `ps/mcp`，以及用户配置的 `node_repl` MCP。

这些与搜索无关，却增加了冷启动时间，网络不稳定时也多了出错的地方（这次失败就卡在 `ps/mcp` 和模型列表上）。另外，没有加 `--ephemeral` 时，这些会话会写进用户的 `~/.codex/sessions` 历史。

计费：`~/.codex/auth.json` 中 `auth_mode = chatgpt`，没有 API key，所以不会按 token 另外收钱，但会**扣 ChatGPT 订阅的 5 小时 / 每周用量额度**，额度消耗随模型大小和推理强度增加。

## 4. 是否都是深度搜索

**是。目前没有浅搜索模式。** 每次调用都是：

- `gpt-6-sol` 加 `high` 推理强度；
- 最多搜 ⌈max_results/2⌉ 次，默认 3 次；
- 写出综合回答，最后附上 Sources 列表。

即使只想“列出几条链接”，也要付出完整代价。本机 Codex 模型缓存（`~/.codex/models_cache.json`）中有更便宜的 `gpt-5.6-luna`、`gpt-6-luna`。oh-my-pi 就是把 Codex 搜索固定交给 `gpt-5.6-luna`（见 `oh-my-pi-codex-websearch.zh.md`）。

## 5. 日志在哪

| 位置 | 内容 | 说明 |
|---|---|---|
| 服务端 | **没有** | 目前的缺口 |
| `~/Library/Caches/claude-cli-nodejs/<项目>/mcp-logs-subscription-powers/*.jsonl` | Claude Code 客户端记录的每次调用开始、耗时、失败时的完整返回（含 stderr 末尾） | 只有 Claude Code 写；mirasim 启动的会话里的调用不会出现在这里 |
| `~/.claude/projects/<项目>/*.jsonl` | 对话记录中的 `tool_use` / `tool_result` | 能看到调用参数和转入后台的提示 |
| `~/.codex/logs_2.sqlite` | codex 进程日志（表 `logs`，按 `process_uuid` 区分进程） | 用 `?mode=ro&immutable=1` 只读打开，不影响运行中的 codex |

## 6. Claude 后端

本机**没有 Claude 订阅**：钥匙串里没有 `Claude Code-credentials`，也没有 `~/.claude/.credentials.json`。

但 `claude auth status` 显示 `loggedIn: true, authMethod: oauth_token`，原因是 **`~/.claude/settings.json` 的 `env` 配置块**：

- `ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/coding`（火山方舟 Coding Plan 的 Anthropic 兼容接口）
- `ANTHROPIC_AUTH_TOKEN=…`（`claude auth status` 把这个 bearer token 报告为 `oauth_token`）
- `ANTHROPIC_MODEL=ark-code-latest`，各档模型映射到 `glm-5.3` / `glm-5.3-flash` / `deepseek-v4-pro` / `kimi-k3`

这个文件不是 mirasim 写的（`~/.mirasim/setting.json` 中没有 volces）。mirasim 只给它启动的会话注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>/…` 环境变量，`cleanEnv()` 会清掉。

**设计缺陷**：`cleanEnv()` 只清理进程环境变量，而 Claude Code 启动时会**自己读取** `settings.json` 的 `env` 配置块并应用。所以 `claude -p` 子进程实际走的是用户在 `settings.json` 里配置的服务商，不一定是 Claude 订阅。10-23 06:54 的两次 `claude_web_search`（9 / 10 轮，返回中有真实 URL）就是用火山方舟的模型跑的，结果里的 `cost_usd_list_price`（$0.41 / $0.77）是 Claude Code 按 Claude 价目表估算的，与实际计费无关。这两次能拿到 URL，具体是靠服务端的 WebSearch 还是本地的 WebFetch，目前没有核实。

已处理：`claude_web_search`、`claude_web_fetch`、`claude_run` 改为**默认不注册**。需要时设置环境变量 `SUBPOW_ENABLE_CLAUDE=1` 重新开启。已经在运行的 MCP 进程仍是旧代码，要重启会话或新开会话才会生效。

## 7. 改进建议（尚未实施）

1. **`mode: "quick" | "deep"`，默认 quick**
   - quick：`-m gpt-5.6-luna -c model_reasoning_effort="low"`，只搜 1 次，不写综合回答，只返回“标题 / URL / 一句话摘要”的列表。
   - deep：保留现在的做法，模型和推理强度可以通过参数指定。
2. **精简启动**：加 `--ephemeral`（不写会话历史）和 `--disable plugins --disable apps`。也可以考虑用 `--ignore-user-config`（跳过 `config.toml`，认证仍用 `CODEX_HOME`）再显式指定模型。哪些开关能用、能省多少时间，要实测后确定。
3. **网络错误重试**：stderr 中出现 `routing discovery failed`、`request timed out` 或 `error sending request` 时，归类为 `codex_network`，自动重试一次。
4. **服务端日志**：每次调用写一行到 `~/.cache/subscription-powers/calls.jsonl`，记录工具、排队时间、运行时间、模型、usage 和错误码。返回结果里也带上 `queued_ms`。
5. **（可选）不用大模型的列表搜索**：通过 DuckDuckGo 或 SearXNG 直接取搜索结果，几秒完成、不消耗订阅额度，但不再属于“订阅能力”。
