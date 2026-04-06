# IM Channel 架构对比调研报告

> 调研时间：2026-04-06
> 目标：评估将 AI Coding Agent 接入 IM 平台（特别是飞书）的技术方案

---

## 1. 背景与问题

Claude Code 在 v2.1.80+ 引入了 **Channels** 功能（Research Preview），允许通过 Telegram/Discord 等 IM 平台远程控制正在运行的 Claude Code 会话。在评估将飞书接入 Claude Code 的可行性时，我们发现了以下核心问题：

- Channels 采用 MCP server 架构，每个 Claude 实例 spawn 一个 MCP server 子进程
- 多实例场景下，MCP server 之间会抢占外部 IM 连接（如飞书 WebSocket、Telegram getUpdates）
- 官方 issue #36800 暴露了 harness 会无端 spawn 重复的 channel plugin 进程，导致 409 Conflict 和工具丢失

这促使我们调研了三种不同的架构方案。

---

## 2. 三种架构方案对比

### 2.1 Claude Code 官方 Channels

**架构模型：1:1 绑定（Claude 进程 spawn MCP server）**

```
Claude Code 实例 A ──spawn──▶ MCP Server A ──polling/WS──▶ Telegram Bot
Claude Code 实例 B ──spawn──▶ MCP Server B ──polling/WS──▶ ❌ 冲突！
```

**技术细节：**

- Channel 在 MCP Server constructor 中声明能力：`capabilities.experimental['claude/channel']`
- 通过 `notifications/claude/channel` 通知方法推送消息到 Claude Code 会话
- 使用 `StdioServerTransport` 通信
- v2.1.81+ 支持 `notifications/claude/channel/permission` 远程工具审批
- 基于 allowlist 的 sender gating 安全机制
- 需要 `--channels` 标志启用，且需要 claude.ai 登录

**官方插件：**

| 插件 | 连接方式 | 冲突风险 |
|------|----------|----------|
| Telegram (Grammy) | `getUpdates` 长轮询（独占） | **高** — 同一 token 只能有一个 poller |
| Discord (discord.js) | Gateway WebSocket | **中** — Discord 网关对重复连接有一定容忍 |

**已知问题：**

- **Issue #36800**（仍 Open）：Claude Code harness 在会话中途无端 spawn 重复 channel plugin 进程
  - 健康运行 ~3 分钟后突然出现第二个进程
  - 导致 409 Conflict（Telegram）/ 连接竞争（Discord/WhatsApp）
  - 工具从会话中消失（`Error: No such tool available`）
  - 影响范围不限于 Channel 插件，普通 MCP server 在 `/mcp` 重连时也受影响
  - 社区 workaround：tmux send-keys + cron 自动修复
  - Anthropic 官方回应：确认问题，修复时间未知

**设计定位：**

Channels 的设计目标是 **个人开发者场景** — 一个开发者在终端跑着 Claude Code，想通过手机上的 Telegram/Discord 继续对话。本质是"远程操控我正在跑的那个 Claude 会话"，不是"IM bot 平台"。

**局限性：**

- 不支持多用户/多会话
- 每个 Claude 实例只能绑定一个 channel
- 长连接类平台（飞书 WS、Telegram polling）天然冲突
- 不适合生产级部署

---

### 2.2 cc-connect（网关模式）

**仓库：** https://github.com/chenhg5/cc-connect
**语言：** Go（单二进制文件）
**本地安装路径：** `/home/anyanmoca/.npm-global/lib/node_modules/cc-connect`
**源码路径：** `/mnt/e/code/cc-connect`

**架构模型：独立网关进程 spawn Claude CLI 子进程**

```
飞书 WS ──┐
企微 WS ──┤     ┌──────────────────┐     ┌─────────────────┐
Telegram ──┼────▶│  cc-connect      │────▶│  claude          │
Discord ──┤     │  (Go 单进程网关)   │     │  --output-format │
钉钉 ────┘     │  路由/会话管理     │     │  stream-json     │
                └──────────────────┘     └─────────────────┘
                      │                         │
               每个用户会话对应            stdin/stdout JSON 流
               一个独立 claude 子进程      双向通信
```

**Agent 执行方式：**

```go
cmd := exec.CommandContext(ctx, "claude",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--resume", sessionID,
)
stdin, _ := cmd.StdinPipe()
stdout, _ := cmd.StdoutPipe()
cmd.Start()
```

**核心技术特点：**

- **JSON 流通信**：通过 `--output-format stream-json` 和 `--input-format stream-json` 实现 Claude CLI 的结构化双向通信，完全绕开 MCP 协议
- **按需启停**：用户发消息时 spawn 进程，后续消息复用（`--resume sessionID`），空闲超时自动回收（默认 15 分钟）
- **物理隔离**：每个会话一个独立 claude 子进程，Session Key 格式 `feishu:{chatID}:{userID}`
- **权限处理**：支持 auto/acceptEdits/dontAsk/default 模式，通过 `--permission-prompt-tool stdio` 将权限请求转发到 IM 平台
- **多 Agent 支持**：Claude Code、Codex、Cursor Agent、Gemini CLI、Qoder CLI、OpenCode、iFlow CLI（7 种）

**支持平台（10 个）：**

| 平台 | 连接方式 | 需要公网 IP |
|------|----------|-------------|
| 飞书 (Lark) | WebSocket | 否 |
| 钉钉 | Stream | 否 |
| 企业微信 | WebSocket / Webhook | 否 (WS) / 是 (Webhook) |
| 微信个人号 (beta) | ilink HTTP 长轮询 | 否 |
| Telegram | Long Polling | 否 |
| Discord | Gateway | 否 |
| Slack | Socket Mode | 否 |
| LINE | Webhook | 是 |
| QQ (NapCat) | WebSocket | 否 |
| QQ Bot (Official) | WebSocket | 否 |

**飞书集成细节：**

- WebSocket 长连接接收事件
- OAuth 认证（app_id + app_secret），自动 token 刷新
- 支持消息类型：文本、图片、音频、文件、富文本、合并转发
- Reaction emoji 作为 typing 指示器
- 消息去重 + 旧消息过滤（忽略重启前的消息）
- 群聊 @提及检测，仅响应被 @的消息

**本地配置（~/.cc-connect/config.toml）：**

```toml
[[projects]]
  name = "anyan-feishu"
  [projects.agent]
    type = "claudecode"
    [projects.agent.options]
      mode = "bypassPermissions"
      work_dir = "/mnt/e/code/anyan_agent"
  [[projects.platforms]]
    type = "feishu"
    [projects.platforms.options]
      app_id = "cli_a934c1011e789cd3"
      app_secret = "***"
```

---

### 2.3 OpenClaw（单进程 Gateway 模式）

**仓库：** https://github.com/openclaw/openclaw
**语言：** TypeScript (Node.js)
**源码路径：** `/mnt/e/code/openclaw`

**架构模型：单进程 Gateway + 直接 API 调用**

```
所有 IM 平台 ──┐
              │     ┌────────────────────────────────┐
Telegram ─────┤     │  OpenClaw (单进程)              │
Discord ──────┤────▶│  Gateway (WS :18789)            │──▶ 直接调 AI API
飞书 ─────────┤     │  Session 管理 (逻辑隔离)        │    (Anthropic/OpenAI/Ollama/...)
Slack ────────┤     │  Channel 插件注册表              │
WhatsApp ─────┘     │  Process Supervisor             │
                    └────────────────────────────────┘
```

**核心技术特点：**

- **直接 API 调用**：不 spawn 外部 Claude Code 进程，自己通过 API 直接调用模型。CLI 后端是可选的抽象层
- **单进程**：所有逻辑在一个 Node.js 进程内，通过 session key 逻辑隔离，不需要物理进程隔离
- **插件化 Channel 系统**：每个平台是一个 extension，实现标准 contract 接口
- **CLI 后端抽象**：支持多种后端（Anthropic API、OpenAI API、Ollama、Claude CLI 等），可运行时切换
- **Gateway 协议**：WebSocket 控制面，管理会话、通道、工具和事件

**Channel 插件系统：**

```typescript
// extensions/feishu/channel-entry.ts
export default defineChannelPluginEntry({
  id: "feishu",
  name: "Feishu",
  plugin: feishuPlugin,         // 实现 standard contract
  setRuntime: setFeishuRuntime, // 注册到 gateway
});
```

**5 层会话绑定：**

Session Key 格式：`agent:<agentId>:<channel>:<peerKind>:<peerId>`

**Process Supervisor：**

提供 CLI 后端进程管理能力：
- 超时管理（总体超时 + 无输出超时）
- 输出捕获（stdout/stderr）
- 优雅取消
- 进程树管理

**支持平台/模型（20+ extension）：**

Channel 平台：飞书、Discord、Telegram、Slack、WhatsApp、Signal、iMessage、Matrix、IRC、Mattermost、MS Teams、LINE、QQ Bot、Zalo、微信（腾讯官方插件）、小米等

模型提供商：Anthropic、OpenAI、Google、DeepSeek、Groq、Mistral、Ollama、LiteLLM、OpenRouter、Together、Fireworks、Volcengine 等

---

## 3. 综合对比矩阵

| 维度 | Claude Code Channels | cc-connect | OpenClaw |
|------|---------------------|------------|----------|
| **进程模型** | Claude spawn MCP server | 独立网关 spawn Claude CLI | 单进程 Gateway |
| **Agent 执行** | MCP 协议（stdio） | JSON 流（stdin/stdout） | 直接 API 调用 |
| **会话隔离** | 无（1:1 绑定） | 物理隔离（子进程） | 逻辑隔离（session key） |
| **多用户** | 不支持 | 支持 | 支持 |
| **多模型** | 仅 Claude | 仅 Claude CLI | 插件化多模型 |
| **多 Agent** | 仅 Claude Code | 7 种 Agent | 多种后端 + CLI |
| **飞书支持** | 无官方插件 | WebSocket 原生支持 | Extension 插件 |
| **稳定性** | 有 harness bug（#36800） | 稳定 | 稳定 |
| **部署复杂度** | 低（内置功能） | 低（单 Go 二进制） | 中（Node.js + 多扩展） |
| **二次开发** | 需走 MCP server 规范 | Go 源码修改 | TypeScript 插件系统 |
| **资源消耗** | 中（每实例一个 MCP server） | 高（每会话一个 claude 进程） | 低（单进程共享） |
| **社区活跃度** | 官方（Research Preview） | 活跃（社区项目） | 非常活跃（社区项目） |
| **开源协议** | 闭源 | MIT | MIT |

---

## 4. 场景推荐

| 使用场景 | 推荐方案 | 理由 |
|----------|----------|------|
| 个人开发者，只想通过手机远程控制 Claude Code | Claude Code Channels（Telegram/Discord） | 开箱即用，不需要额外部署 |
| 个人/小团队，Claude Code + 飞书 | **cc-connect** | 轻量、Go 单二进制、飞书 WebSocket 原生支持 |
| 多模型需求（Claude + GPT + Ollama 等） | OpenClaw | 插件化多模型支持 |
| 生产级多租户部署 | OpenClaw | 单进程高效、逻辑隔离、插件生态丰富 |
| 需要微信个人号支持 | cc-connect beta / OpenClaw | 两者都有微信支持 |
| 需要深度二次开发/扩展新平台 | OpenClaw | 标准化 plugin contract 接口 |
| 最小依赖、快速上手 | cc-connect | 单 Go 二进制，零外部依赖 |

---

## 5. 关键结论

1. **Claude Code Channels 的设计目标是个人远程控制，不是 IM bot 平台。** 其 1:1 MCP server 架构在多实例/多用户场景下天然冲突，且有未修复的 harness bug（#36800）。

2. **cc-connect 采用"网关模式"**，独立进程作为消息路由器，按需 spawn Claude CLI 子进程。物理隔离保证了会话安全，但资源消耗较高（每会话一个进程）。已在本机部署并配置了飞书和企业微信。

3. **OpenClaw 采用"单运行时模式"**，自己作为 AI 运行时直接调模型 API，不依赖外部 Claude 进程。资源效率最高，插件系统最完善，但部署复杂度也最高。

4. **对于飞书集成场景，cc-connect 是当前最佳选择。** 如果后续需要多模型或更复杂的插件生态，可以迁移到 OpenClaw。

---

## 6. 参考资料

- [Claude Code Channels 官方文档](https://code.claude.com/docs/en/channels-reference)
- [Claude Code Channels 官方插件仓库](https://github.com/anthropics/claude-plugins-official)
- [Issue #36800: Duplicate channel plugin spawn bug](https://github.com/anthropics/claude-code/issues/36800)
- [cc-connect GitHub](https://github.com/chenhg5/cc-connect)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw 架构概述](https://github.com/openclaw/openclaw/blob/main/docs/architecture.md)
- [claw0: 从零学习 OpenClaw](https://github.com/shareAI-lab/claw0)
