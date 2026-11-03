# Codex 内置搜索的形态，以及怎样让模型主动调用我们的 MCP

> 2026-11-03。起因是两个问题：Codex 订阅里的内置 Web Search 是以什么形式嵌进去的、能不能做成"插件"放进去而不走 MCP 和 Skill；以及你担心模型"总是想不起来调这个 MCP"。
>
> **依据**：`/openai/codex` 的源码文档（通过 ctx7 查询）、本机 codex-cli 0.166.0 的命令与 schema、本机 `~/.codex/config.toml`，以及之前对 oh-my-pi 的分析（`oh-my-pi-codex-websearch.zh.md`）。**没有使用网页搜索**。凡是没有验证的，下文都标了"未验证"。

## 1. 结论

| 问题 | 回答 |
|---|---|
| 内置 Web Search 是插件吗？ | **不是。** 它是 OpenAI **服务端托管**的工具：Codex 只是在请求里声明 `web_search` 工具，搜索由 OpenAI 服务端执行，本地没有搜索代码。 |
| 能做一个同类插件放进 Codex，不走 MCP 也不走 Skill 吗？ | **插件这条路不行**：插件清单只能声明 skills、MCP 服务、apps、hooks，本质上是把 MCP 和 Skill 打包。**有一条例外**：自己写宿主程序，通过 `codex app-server` 注册 `dynamicTools`，但只对这个宿主启动的 Codex 有效。 |
| 模型想不起来调 MCP，怎么办？ | 我们的服务端原来**没写 `instructions`**，而 Codex 和 Claude Code 都会把它交给模型。现在已补上，并在工具描述里写成指令；再建议你在 `AGENTS.md` / `CLAUDE.md` 里加一句话。 |

## 2. 内置 Web Search 是什么形式

**请求里声明，服务端执行。**

- Codex 发给模型的 Responses 请求里带 `tools:[{type:"web_search"}]`；模型决定搜索后，由 OpenAI 的服务端去搜，结果以 `web_search_call` 项流回客户端。这与我们 `codex_api_search` 强制使用的是同一个机制（见 `codex-oauth-websearch-plan.zh.md`）。
- 本地只能控制"模式"：配置项 `web_search`，取值 `disabled` / `cached`（默认）/ `indexed` / `live`。**你的 `~/.codex/config.toml` 里是 `indexed`。**
- 源码里按回合决定实际模式（`resolve_web_search_mode_for_turn`）：
  - `live` 和 `indexed` 需要服务商支持 `external_web_access`，否则会降级到 `cached` 或 `disabled`。
  - 权限配置为 danger-full-access（沙箱关闭）时，会优先提升到 `live`。
- 另有特性开关 `standalone_web_search`，本机 `codex features list` 显示为"开发中"，默认关闭；旧的 `web_search_cached`、`web_search_request` 已标为弃用。

**由此得到的推论**：
- 它依赖"模型在 OpenAI 那边"。走第三方中转或自定义服务商时，这个托管工具通常没有，这正是我们做 MCP 搜索的原因。这一点是从源码里 `external_web_access` 的能力判断和我们之前的实测得出的，没有针对每个中转逐一验证。
- 本地没有可以替换的"搜索实现"，所以不存在"换掉它的内部"这种改法。

## 3. Codex 的"插件"到底是什么

- 命令：`codex plugin add / list / remove / marketplace`。
- 清单（manifest）声明的资源，源码里枚举为：`skills`、`onboarding_skill`、`mcp_servers`、`apps`、`hooks`。**没有"自定义工具"，也没有 `agents` 字段。**
- 文档里的原话大意：插件是可从市场或本地安装的包，清单里指定 MCP 服务、apps、hooks 和 skill 目录；单独一个 `SKILL.md` 则是不带清单的 skill。
- 本机已装的 `browser@openai-bundled`、`computer-use@openai-bundled`、`pdf@openai-primary-runtime` 等，也是这个形式。

**所以**："插件，但不走 MCP 也不走 Skill"在清单层面没有对应的东西。能声明的只剩 `apps`（连接器，同样是工具提供方式）和 `hooks`。

## 4. 不走 MCP 和 Skill 的各条路

| 路线 | 结论 | 依据 / 说明 |
|---|---|---|
| 做成插件 | 不行 | 清单只能声明上面五项 |
| **app-server 的 `dynamicTools`** | **可行，有前提** | 本机 `codex app-server generate-json-schema` 生成的 schema 里有 `DynamicToolSpec`：函数型工具含 `name`、`description`、`inputSchema`、`deferLoading`，另有带命名空间的形式；还有 `DynamicToolCallParams` / `DynamicToolCallResponse`，即 Codex 调用时把参数回传给客户端、由客户端返回结果。**前提**：你要自己写一个宿主程序，用 app-server 协议驱动 Codex；直接用终端界面或 `codex exec` 时没有注册入口。 |
| Hooks（稳定特性） | 不能新增工具 | 只能在事件上执行命令。顶多往上下文里注入内容，很绕。**能否拦截托管的 web_search 未验证**，推测不能，因为它在服务端执行 |
| 改源码（fork Codex） | 技术上可以 | 要长期跟随上游，不划算 |
| 关掉内置搜索，再用别的方式补 | 只是配合 | `web_search = "disabled"` 能避免模型在两个搜索之间犹豫，但补上的工具仍要走 MCP、dynamicTools 之一 |

**务实判断**：MCP 本来就是 Codex 官方的工具扩展点。想要"像内置一样好装"，做法是**把我们的 MCP 打包成 Codex 插件**（清单里声明 `mcp_servers`），用 `codex plugin add` 一条命令安装。这一步**还没做**，是后续可选项。

## 5. "模型想不起来调 MCP"：原因与办法

### 5.1 原因

1. **模型一开始并不知道有这个工具，或不知道该在什么场合用。** 我们的服务端原来没有设置 MCP 的 `instructions`。
2. **名字太普通。** `web_search` 这种名字，在宿主自带 `WebSearch`、模型又习惯"凭记忆答"的时候，很容易被忽略。
3. **（本会话的观察，未证实是主因）** 在 Claude Code 里，MCP 工具常以"延迟加载"的方式出现：模型先只看到工具名，要用时得先去检索它的参数。这会降低"顺手就调"的概率。Codex 里对应的机制我没有核实（本机特性表里 `tool_search_always_defer_mcp_tools` 标为已移除、值为 true，含义未确认）。

### 5.2 已核实的两个机制

- **MCP `instructions` 会交给模型。** Codex 源码 `codex-mcp/src/rmcp_client.rs`：把服务端 `instructions` 设为每个工具的 `namespace_description`，注释写明是"模型可见的命名空间说明"。Claude Code 则把 MCP 服务端的 instructions 放进系统提示（本会话的系统提示里就有"MCP Server Instructions"一节）。
- **`AGENTS.md` 每轮注入。** Codex 源码 `core/src/agents_md.rs`：从当前目录向上到项目根逐个读取 `AGENTS.md`，包装成一条合成的用户消息注入对话。你本机的 `~/.codex/AGENTS.md` 已存在。（项目被标为"不可信"时，只加载用户级指令。）
- 对比：**Skill 要先匹配到描述才会加载**，不是每轮都在，所以不适合承担"别忘了联网搜索"这种常驻提醒。

### 5.3 三层办法（由弱到强）

| 层 | 做法 | 状态 |
|---|---|---|
| 1 | 服务端 `instructions`：需要最新或可核实的在线信息时，先调 `web_search`，不要说自己不能上网；`mode` 怎么选；要图用 `codex_generate_image` / `codex_edit_image`；宿主自带搜索可用时两者并存即可 | **已实现并验证**：用 MCP 客户端连上服务端，初始化结果里能取到这段说明 |
| 2 | `web_search` 的工具描述改成指令式开头："依赖在线信息时调用，而不是凭记忆回答（宿主没有内置搜索时也能用）" | **已实现** |
| 3 | 在 `~/.codex/AGENTS.md`（Claude Code 是 `~/.claude/CLAUDE.md`）里写一句话，见下 | **未替你修改**，建议你加 |

建议加入的内容：

```markdown
需要最新或可核实的在线信息（版本、发布、新闻、文档、价格、"最新"）时，
先调用 subscription-powers 的 `web_search`，再回答；不要凭记忆作答，也不要说无法联网。
```

### 5.4 代码改动

- `server/index.mjs`：新增 `INSTRUCTIONS` 常量，并作为 `new McpServer(info, { instructions })` 的第二个参数传入；`web_search` 的 `description` 改为指令式开头。
- 说明文字刻意**不点名具体后端**（Dot、Codex 直连等），因为开关会随时变，而 `instructions` 在初始化时就固定了。
- 两份 README 新增"让模型想得起来用它"一节。
- 61 个离线测试仍全部通过。

## 6. 没有验证的事

- **效果大小**：这些办法能提高被调用的概率，但**没有做前后对比**，没有量化数据。效果取决于模型和宿主。
- Codex 对 MCP 工具是否做延迟加载，以及这对"是否想得起来"的影响。
- Hooks 能否拦截或观察托管的 `web_search`。
- 打包成 Codex 插件后，`instructions` 与插件清单里的 `skills` 如何叠加。
- 第三方中转下，Codex 内置 `web_search` 是否一定缺失（只对我们遇到过的中转实测过）。

## 7. 可选的后续

1. 把你 `~/.codex/AGENTS.md` 里加上第 5.3 节那一句（需要你同意后我来改）。
2. 把 MCP 打包成 Codex 插件，写清单与一条短 Skill，支持 `codex plugin add`。
3. 如果你想要"完全不装 MCP"，评估自写 app-server 宿主（dynamicTools）能做到什么程度；它只对宿主启动的 Codex 生效。
4. 观察一段时间的 `calls.jsonl`，看 `web_search` 的实际调用频率有没有上升，作为第 6 节"没有量化"的补充。
