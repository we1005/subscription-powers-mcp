# Codex / Claude Code 订阅能力抽取 —— 分析与实施计划

> 2026-09-11。目标：把两个订阅（ChatGPT Plus 的 Codex、Claude Team 的 Claude Code）里**只有订阅才有、公司中转拿不到**的能力，封装成一个 MCP server，让任何 Agent（Claude Code / OpenCode / 公司 Codex / oh-my-pi）都能调用。

## 1. 为什么值得做

| 能力 | 公司中转（llm.makeplay.cc） | 个人订阅 |
|---|---|---|
| 生图 / 改图（gpt-image-2） | ❌ `/v1/images` 404、`image_generation` 工具 403 | ✅ Codex 内置 `image_gen`，按订阅额度计费 |
| 联网搜索 | ❌ GPT 走自定义 provider 时 OpenAI `web_search` 不可用；Claude 系服务端 `web_search` 通（已探）但 OpenCode/Codex 客户端不会自动挂 | ✅ Codex 原生 `web_search`；✅ Claude Code `WebSearch` + `WebFetch`（15 分钟缓存） |
| 顶配模型本体 | ✅ 有（gpt-6-astra、claude-opus-5、claude-fable-5-1） | ✅ 但有 SubAgent/sleep 兼容坑（GPT 路径），订阅侧没有 |

所以真正"独有"的是两样：**生图**和**搜索**。"把顶配模型再包一层"价值不大，但作为"用订阅额度跑一段任务"的兜底工具（比如公司中转故障时）可以保留一个通用 `run` 工具。

## 2. 三条实现路径（结论：A）

| 路径 | 做法 | 判断 |
|---|---|---|
| **A. 子进程封装（选它）** | MCP 内部 `spawn` 官方 CLI：`codex exec …`、`claude -p …` | 完全走官方产品，不碰凭据；能力随 CLI 升级自动跟上；代价是每次冷启动 5–10 s |
| B. 官方 SDK | `@openai/codex-sdk`、`@anthropic-ai/claude-code`（Agent SDK） | 本质仍是起 CLI 进程，多一层依赖，收益是结构化事件；第二阶段可换 |
| C. 复用 OAuth token 直打后端 | 读 `~/.codex/auth.json` / Claude 的 keychain token，自己发 HTTP | 违反使用条款、接口无文档、有封号风险。**不做** |

参考实现 [colin-automates/Codex-ImageGen--Claude-Code](https://github.com/colin-automates/Codex-ImageGen--Claude-Code)（MIT）走的就是 A，可借鉴的点：`--output-last-message` 拿末条回复、`SAVED <path>` 协定 + 磁盘核验、错误分类（未登录 / 超时 / 内容策略）、按 8 KB 截尾保存 stdout/stderr。不借鉴的点：`--sandbox danger-full-access`（用 `workspace-write` + `--cd` 就够）、只做图不做搜索、只给 Claude Code 插件形态。

## 3. 已实测的事实（写代码前必须知道）

- `codex exec` 在个人 HOME 下调用内置 `image_gen` 一次成功：1024×1024 PNG，约 60 s，2.3 万 token，5 小时窗口额度 +1%。
- Claude Code 可以在另一个 Claude Code 会话里被 `-p` 方式启动，但必须**清掉**父进程注入的环境变量：`CLAUDECODE`、`CLAUDE_CODE_*`、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`，否则要么被判定为嵌套、要么被带进公司中转。清掉后 `-p --allowedTools WebSearch,WebFetch --output-format json` 一次搜索 4 轮、$0.36 标价额度，返回带 URL 的答案。
- Codex 的 `--search` 是**全局**参数，不是 `exec` 子命令的参数：写法见 §5 的实测结论。
- 两个 CLI 的 HOME 都必须是个人的：Codex 用默认 `~/.codex`（`auth_mode: chatgpt`），Claude 用默认 `~/.claude`。子进程 env 里显式删除 `CODEX_HOME`、`MAKEPLAY_API_KEY`、`CLAUDE_CONFIG_DIR` 等。
- 额度粗估：Plus 一周约 300–500 张图；搜索一次约等于 1–2 条普通消息。

## 4. 工具设计（MCP tools）

服务名 `subscription-powers`，stdio 传输，Node 24 + `@modelcontextprotocol/sdk`。

| 工具 | 后端 | 参数 | 返回 |
|---|---|---|---|
| `codex_generate_image` | codex exec + image_gen | `prompt`, `out_dir`, `filename?`, `size?`(1024x1024/1536x1024/1024x1536), `background?`(auto/transparent/opaque), `style?`, `reference_image?` | `{ok, path, elapsed_ms, tokens}` |
| `codex_edit_image` | 同上 | `image_path`, `instruction`, `out_path?`, `mask_path?` | 同上 |
| `codex_web_search` | codex exec + 原生 web_search | `query`, `max_results?`, `recency?` | `{ok, answer, sources[]}`（sources 从事件流里提取 URL） |
| `claude_web_search` | claude -p + WebSearch/WebFetch | `query`, `allow_fetch?` | `{ok, answer, sources[], cost_usd, turns}` |
| `claude_web_fetch` | claude -p + WebFetch | `url`, `prompt` | `{ok, answer}` |
| `codex_run` / `claude_run` | 通用任务 | `prompt`, `cwd?`, `model?`, `sandbox?` | `{ok, answer, tokens/cost}`（用订阅额度跑任务的兜底） |

约束：
- **串行队列**：每个后端同一时刻只跑一个子进程（额度和冷启动都不适合并发）。
- **超时**：图 240 s、搜索 180 s、run 600 s，可参数覆盖；超时先 SIGTERM 再 SIGKILL。
- **文件协定**：生图让模型末行只回 `SAVED <abs path>`，服务端 `stat` 核验，找不到就在 `out_dir` 里按最新 PNG 兜底。
- **用量回传**：Codex 用 `--json` 事件流里的 `turn.completed.usage`，Claude 用 `--output-format json` 的 `total_cost_usd` / `modelUsage`，一并放进结果，让调用方感知额度。
- **路径信任**：`out_dir` / `image_path` 只接受绝对路径且不能落在 `~/.codex`、`~/.claude` 这类敏感目录。

## 5. 各客户端接入

```bash
# Claude Code（个人与公司两个环境都可以挂，都是本地 stdio）
claude mcp add --scope user subscription-powers -- node /Volumes/zhitai-7100/codex-claude订阅能力抽取/server/index.mjs
```
```jsonc
// OpenCode  ~/.config/opencode/opencode.json
"subscription-powers": { "type": "local", "command": ["node", "/Volumes/zhitai-7100/codex-claude订阅能力抽取/server/index.mjs"], "enabled": true }
```
```toml
# Codex 公司环境 ~/.codex-company/config.toml（公司 Codex 借个人订阅生图/搜索）
[mcp_servers.subscription-powers]
command = "node"
args = ["/Volumes/zhitai-7100/codex-claude订阅能力抽取/server/index.mjs"]
default_tools_approval_mode = "approve"
```

## 6. 实施步骤

1. `server/`：`package.json`（仅依赖 `@modelcontextprotocol/sdk` + `zod`）、`index.mjs`（工具注册）、`lib/codex.mjs`、`lib/claude.mjs`（各自的 spawn / 解析 / 错误分类）、`lib/queue.mjs`、`lib/paths.mjs`。
2. `tests/smoke.mjs`：用 SDK 的 stdio client 起 server，逐个调用工具（每个后端各一次真实调用，图只生一张）。
3. 接入三个客户端并在 Claude Code 里实际调一次 `codex_generate_image`。
4. README（用法、额度、故障排查、环境变量清单）。

## 7. 风险

- 额度：图比文本贵 3–5 倍，MCP 结果里带用量，且工具描述里写明"确实需要位图时才用"。
- 冷启动：每次 5–10 s，对搜索这种轻操作比例偏高；第二阶段可考虑 `codex mcp-server` / Agent SDK 的长驻会话复用。
- 版本漂移：`image_gen`、`--search` 都是近期特性，Codex 升级可能改名；测试脚本要能一键复验。

## 8. 状态（2026-09-11 晚）

§6 的 1–4 步已完成：`server/` 可运行、`tests/smoke.mjs` 四类工具各真实跑通一次、四个客户端接入并 connected、README 就位。与计划的差异：① 冒烟脚本放在 `server/tests/`（要复用 server 的 node_modules）；② 加了 progress 心跳机制（计划里没预料到客户端 60 s 默认超时）；③ `codex_web_search` 的提示词里加了"不要跑 shell、不要读 skills"——不加时 Codex 会被本机 agent-reach skill 诱导去 `gh release list`，虽然答案对，但更慢更贵。
