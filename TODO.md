# TODO

## 方案 A：自建 OAuth 登录（暂缓）

**状态**：不做，等方案 B 完全跑通并稳定使用一段时间后再考虑。当前 `codex_api_search` 使用方案 B：**只读借用** `~/.codex/auth.json`（从不刷新、不写回）。`subpow codex login` 目前只会打印这条 TODO 说明。

**为什么以后可能还是要做**
- 方案 B 的令牌是 Codex CLI 刷新的，有效期约 10 天。如果你很久不用 Codex（CLI 与桌面应用都不用），令牌会过期，`codex_api_search` 返回 `codex_api_token_expired`，统一入口会兜底到 CLI（CLI 运行时通常会顺带刷新该文件，**这一点未专门验证**）。
- 方案 B 依赖另一个程序的登录文件，不能独立运行。

**要做什么**（完整设计见 `docs/codex-oauth-websearch-plan.zh.md` §4、§9 阶段 1）
- [ ] `subpow codex login`：PKCE 浏览器登录（固定回调 `http://localhost:1455/auth/callback`），`--device` 为设备码登录（端口被占用时用）。授权参数、设备码流程移植自 oh-my-pi 的 `registry/oauth/openai-codex.ts`。
- [ ] 独立保存令牌：`~/.subscription-powers/codex-oauth.json`（0600、原子写），含 access / refresh / 过期时间 / 账号 / 套餐。
- [ ] 跨进程单飞刷新：刷新前拿文件锁，拿到锁后先重读文件，别的进程已刷新就直接用（把 `dot.mjs` 里的锁抽成 `lib/lock.mjs` 共用）。
- [ ] 先验证再实现：刷新令牌是否轮换；同一账号的会话数量是否受限；用 Codex 的 `client_id` 在我们自己的程序里能否登录成功。
- [ ] `lib/codex-auth.mjs` 增加来源选择：优先自有登录，找不到再回退到只读借用。
- [ ] 令牌来源写进 `codex status` 与 `calls.jsonl`。
- [ ] 测试：假授权服务器（`/oauth/token`）、并发刷新只触发一次、刷新失败（`invalid_grant`）的熔断。

## 其它待办

**Codex 直连（`codex_api_search`）**
- [ ] 实测 Pro 到期后的表现（现在只是推断：套餐变化立即熔断，或 401/403 连续 3 次熔断）。
- [ ] `status` 展示 `/backend-api/wham/usage` 的额度窗口（5 小时 / 7 天），并弄清搜索请求是否计入。
- [ ] 验证"CLI 兜底会顺带刷新过期令牌"。
- [ ] 观察 `version` 头（取自本机 `codex --version`）与 `originator: subscription-powers` 是否长期被接受。

**Dot（`dot_web_search`）**
- [x] 路线 3：`subpow dot capture` 用日常 Chrome + chrome-agent-bridge 自动抓取登录态，`subpow dot auto-capture on` 在登录态失效时自动重抓（已实测：故意弄坏凭据后一次搜索自愈）。
- [ ] 路线 3 的小缺口：没有登录态文件时不会自动首抓；抓取后 `session_expires` 要等第一次刷新才有。
- [ ] 路线 2：专用 Chrome + CDP（仅在直连被 Cloudflare 或 Sentinel 拦截时才需要）。
- [ ] 套餐变化即熔断（Dot 的令牌里同样有 `chatgpt_plan_type`）、网络错误重试、改用 `live` SSE 代替轮询。见 `docs/dot-direct-api-implementation-log.zh.md` §6.3。

**固定 ChatGPT 网页会话搜索（`chatgpt_web_search`）——已实现，默认关闭**
- [x] 驱动页面发送 + 读结构化来源；`subpow web session set|show|clear`、`web on|off|reset|check|search`；热开关、熔断、并入统一入口、跨进程锁（实现记录见 `docs/chatgpt-session-websearch-plan.zh.md` §13）。
- [ ] 验证标签页在后台（不可见）时输入和回车是否可靠。
- [ ] 固定会话会持续变长：加"会话已很长，建议换新会话"的提示，或自动换会话。
- [ ] 登录态失效时自动重抓（Dot 有，这个没做）；套餐/账号绑定熔断。
- [ ] 弄清搜索消息是否计入额度、上限是多少；"Instant"是否真的更快。

**统一入口（`web_search`）**
- [ ] 视需要加入本机已有的 searxng 作为最后兜底（它是独立的 MCP，不在本项目内）。

**Claude 后端**
- [ ] 目前默认关闭。若要重新开启，需要让 `claude -p` 显式使用 Claude 订阅登录；`~/.claude/settings.json` 的 `env` 块会让它走别的服务商（见 `docs/parallel-search-failure-analysis.zh.md` §6）。

**工程**
- [ ] 所有改动尚未提交。
