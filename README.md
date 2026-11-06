# AI Studio — 基于 VS Code 的 AI-Native 代码编辑器

AI Studio 是 [Code - OSS](https://github.com/microsoft/vscode) 的深度定制分支，将 VS Code 改造为 AI-first 的智能编程环境。核心目标是：**完全使用用户自定义模型，不绑定任何商业 AI 服务**。

## 上游与设计参考

| 项目 | 说明 |
|------|------|
| [microsoft/vscode](https://github.com/microsoft/vscode) | VS Code OSS 上游，AI Studio 的编辑器内核来源 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | Claude Code 的公开交互、插件和用法，作为第一阶段的产品参考 |

---

## 架构概览

```
VS Code Shell (Monaco Editor + Workbench)
          |
AI Runtime Layer (自研)
├── AI Orchestrator     任务解析、计划生成、执行调度
├── Agent Runtime       状态机：idle → planning → executing → refining → done
├── Tool System         文件编辑、终端执行、工作区搜索、Git 操作
├── Codebase Index      代码分块 → Embedding → 语义搜索
├── LLM Provider        OpenAI / Anthropic / 自定义 API 统一抽象
├── Patch Engine        Unified Diff 应用、回滚、冲突检测
└── Agent UI            Chat Panel / Plan View / Timeline / Diff Preview
```

设计原则：

- 不破坏 VS Code Editor Core（Monaco、File System、Extension Host）
- 通过 DI override 替换 AI 原生服务
- VS Code 已有的能力（编辑器内核、终端、Git UI）全部复用，不做重写

---

## 自研核心模块

### AI Orchestrator

系统的核心调度器，负责将用户的自然语言任务解析为结构化执行计划，驱动 Agent Runtime 循环，并在每轮执行后根据工具返回结果进行自我修正，直至判定任务完成。

### Agent Runtime

AI 行为状态机，实现 `plan → execute → observe → refine` 闭环。支持最大步数限制、错误重试、上下文压缩以及大输出自动落盘（`.ai-studio/tool-outputs`）。

代码路径：`src/vs/platform/ai/browser/aiAgentService.ts`

### Tool System

运行时向模型提供以下 11 个基础工具，另有任务、计划、提问、记忆和子智能体等编排工具。

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件（含行号、offset/limit、图片 base64、PDF 元数据） |
| `write_file` | 创建/覆写文件 |
| `edit_file` | 精确字符串替换编辑（old_string/new_string/replace_all） |
| `search_content` | 代码库混合语义+关键词搜索 |
| `search_files` | Glob 模式文件匹配 |
| `search_pattern` | 原始 ripgrep 正则搜索 |
| `run_command` | Shell 命令执行（安全白名单+审批策略+超时） |
| `list_directory` | 目录浏览 |
| `read_lints` | Linter 诊断（单文件/工作区） |
| `web_fetch` | 按 URL 抓取网页，将 HTML 转为纯文本。支持 HTTP/HTTPS 跳转和取消。 |
| `web_search` | 优先查询 DuckDuckGo Lite，遇到超时、验证页或无效响应时将同一查询词发给 Bing RSS。返回标题、链接及可用摘要。 |

桌面端统一跟随本机系统代理。网页工具、模型 API、向量索引、扩展市场和本机扩展的标准 HTTP 客户端都由系统决定走代理或直连，支持系统 PAC 和绕过规则。需要调整代理时，在操作系统的网络设置中修改即可。

代码路径：`src/vs/platform/ai/common/aiTools.ts`（定义）、`src/vs/platform/ai/browser/toolExecutor.ts`（执行）

### Codebase Index

按工作区目录分别建立代码块索引，合并向量检索和 `rg` 关键词检索结果。桌面渲染进程通过 IndexedDB 保存向量并按余弦相似度检索；在 Node 环境中可使用 SQLite 及可选的 HNSW 加速。

代码路径：`src/vs/platform/ai/browser/aiIndexService.ts`、`indexBuilder.ts`

### LLM Provider Layer

统一模型接口抽象层，支持：

- OpenAI API（及任意兼容接口，如 Ollama、vLLM、LiteLLM 等）
- Anthropic Claude API
- 自定义 HTTP API

通过 `ai.apiBase` 配置任意兼容端点，模型选择权完全在用户手中。

代码路径：`src/vs/platform/ai/browser/aiModelService.ts`

### Patch Engine

文件工具写入后记录修改前后的内容。可从会话打开只读差异对比，逐项保留或撤销。撤销前会校验磁盘内容和编辑器中的未保存改动，发生冲突时保留当前文件并提示处理。审查状态保存在工作区首个本地目录的 `.ai-studio/diffs.json`。

代码路径：`src/vs/workbench/contrib/aiDiffApply/`

### Agent UI

新窗口默认进入智能体工作区：单层导航标题栏、左侧窄图标栏与项目会话列表、中间聊天区域、右侧悬浮任务详情。基本模式隐藏编辑器标签和重复面板标题；文件编辑、终端、差异审查与底层工作台能力仍然保留，高级模式可恢复完整界面。

新会话页采用简洁标题与输入框。输入框显示实际使用的模型，提供审批入口、推理强度调节和附件缩略图；模型、附件和导航菜单由应用绘制并带弹出动画。左侧保留项目、会话搜索、文件、变更与技能连接入口，终端入口仅在高级模式显示。标题栏的浅色／深色按钮切换完整工作台主题并保存到用户设置。基本模式在窄窗口自动收起侧栏，放宽后恢复，也允许手动展开；不关闭文件或终端进程。

推理强度通过 `ai.reasoningEffort` 保存，界面和请求共用能力判断。已确认支持的 OpenAI Chat Completions 模型使用 `reasoning_effort`；DeepSeek 只显示实际可区分的档位并保留工具循环中的推理续接数据；支持独立 effort 的 Claude 4.x 使用 `output_config.effort`，不会因此开启尚未接入的扩展 thinking 协议。其他模型保留服务默认值，控件会说明暂不可调。参数依据 [OpenAI 推理文档](https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat)、[Claude effort 文档](https://platform.claude.com/docs/en/build-with-claude/effort)和 [DeepSeek thinking 文档](https://api-docs.deepseek.com/guides/thinking_mode/)。

代码路径：`src/vs/workbench/contrib/studioShell/`、`aiChat/`、`aiContextView/`、`aiDiffApply/`。

---

## 目录结构

```
src/vs/platform/ai/                  AI 平台服务层
  common/
    aiTypes.ts                          核心类型定义（AITool, AgentSession, BuiltInToolName 等）
    aiTools.ts                          11 个工具定义（JSON Schema）
    aiConfiguration.ts                  配置注册（ai.* 设置项）
    systemPrompt.ts                     Agent 系统提示词（~150 行）
    projectRules.ts                     CLAUDE.md/AISTUDIO.md 自动发现（5 级扫描）
    conversationMemory.ts               对话记忆 + 上下文压缩
    memoryStore.ts                      会话持久化（AgentSession JSONL 格式）
    tokenCounter.ts                     Token 计数
    anthropicProvider.ts                Anthropic Messages API（SSE 流）
    customProvider.ts                   OpenAI/兼容 API（SSE 流）
  browser/
    aiAgentService.ts                   Agent 循环核心（多轮 tool-use 循环）
    aiModelService.ts                   LLM Provider 管理（热切换）
    aiContextService.ts                 上下文组装（系统提示词 + 规则 + 编辑状态 + 计划）
    toolExecutor.ts                     工具执行器（11 个工具 + 快照/回滚）
    aiIndexService.ts                   语义索引服务
    indexBuilder.ts                     索引构建器
    credentialService.ts                密钥存储（SecretStorage）
src/vs/workbench/contrib/
  aiChat/                               AI Chat 面板（agent 桥接 + 流式渲染）
  aiDiffApply/                          Diff 审查（接受/拒绝/回滚 + multiDiffData UI）
  aiContextView/                        AI 上下文视图
  aiStatusBar/                          AI 状态栏指示器
```

---

## 快速开始

桌面开发环境使用 [.nvmrc](.nvmrc) 指定的 Node.js 22 版本，支持同一主版本下更高的补丁或次版本。请使用 npm 低于 11.2.0 的版本。建议 4 核 CPU、8 GB 内存。单独编译 Rust CLI 时还需要 Rust 和 Cargo。

```bash
npm ci
npm run compile
./scripts/code.sh          # macOS / Linux
scripts\code.bat           # Windows
```

运行 AI 模块的离线回归测试可使用 `npm run test:ai`。

在 macOS 上运行 `npm run package:mac -- --version=1.122.0-preview.1` 可构建当前处理器架构的应用和 DMG。输出位于 `.build/release/`，包含安装包及 SHA-256 校验文件；磁盘镜像内提供应用与 `Applications` 快捷方式。脚本复用现有生产构建流程和 Electron 签名工具，不包含用户配置或模型密钥。已有完整构建可用 `--skip-build` 只生成磁盘镜像。

构建后可运行 `npm run test:ai:package` 验证正式应用的独立启动、本地模型流式请求、文件工具、模型列表、系统代理及中文缓存。测试使用临时用户配置和本机模拟服务；设置 `STUDIO_TEST_APP` 可指定从 DMG 复制出来的应用可执行文件。

未设置 `CODESIGN_IDENTITY` 时使用临时签名，安装包未经 Apple 公证，macOS 首次运行可能需要在「系统设置 → 隐私与安全性」中允许打开。Developer ID 签名和公证需自行配置 Apple 开发者凭据。预览版仍保留上游 Agent Host 占位模块相关的全量类型检查错误；AI Studio 核心回归与正式构建使用各自独立的检查流程。

桌面首次启动默认使用简体中文。核心菜单、编辑器命令、设置说明及内置扩展的译文随项目分发，可断网启动。上游译文来自与编辑器版本匹配的 [Microsoft 简体中文语言包](https://github.com/microsoft/vscode-loc/tree/6328467f46f70a56566410dc5dcce9d6e2fec2f9/i18n/vscode-language-pack-zh-hans)。使用 `./scripts/code.sh --locale=en` 可显式选择英文核心界面。

启动后使用标题栏「设置 → 管理模型」，填写配置名称、模型 ID、接口类型和 API 地址。默认界面围绕任务、项目和文件展开；「设置 → 高级模式」可显示终端、调试、编辑器工具栏与完整设置。切换模式保留未保存的文件、终端进程和原有布局，不改写用户的编辑器展示设置。

「设置 → 技能与工具」及输入框左侧「+」提供技能、插件和 MCP 连接入口：

- 技能复用已有的 `SKILL.md` 发现机制；可添加本机技能集合目录、创建技能，并将技能附加到本轮会话。
- 插件复用现有插件清单与启停机制；通过本机插件文件夹添加技能和 MCP 工具包。
- MCP 复用现有连接、信任、授权与工具服务，连接成功的工具进入主 Agent 的调用链；停用的工具不会继续执行。只读计划模式暂不开放 MCP 工具。
- 网络继续跟随系统代理，不增加应用内代理配置。第三方本机 MCP 程序自身发起的网络请求由该程序负责，应用不能替外部进程承诺代理行为。

文件可以拖入输入框或通过「+」添加，附件以缩略图卡片展示。macOS/Windows 文档预览复用系统缩略图；不支持的格式或平台显示文件类型卡片。预览不会把文档转成模型输入：文本与图片按已有附件规则发送，PDF、Word 等二进制文件目前仅发送路径引用。点击卡片右上角「×」会从后续请求中移除该附件。

技能与 MCP 的隔离回归可使用 `npm run test:ai:capabilities`，详见 [测试说明](test/integration/ai-capabilities/README.md)。

| 配置项 | 说明 |
|--------|------|
| `ai.apiType` | 接口格式：`openai`（含兼容服务）或 `anthropic` |
| `ai.apiBase` | API 端点地址 |
| `ai.apiKey` | 旧版密钥配置；新配置通过模型表单输入 |
| `ai.modelId` | 模型 ID |

---

## 项目状态

第一阶段参照 Claude Code 公开可见的项目指令、工具使用和会话体验，由 AI Studio 自行实现。旧版 README 将这部分称为“运行时架构移植”，公开材料不足以支持这一说法。[Claude Code 公开仓库](https://github.com/anthropics/claude-code)

### 可复查的工具调用实现

本轮选取三个拥有公开工具运行时、GitHub Star 超过十万的编码智能体。2026-11-05 查看仓库时，[OpenCode](https://github.com/anomalyco/opencode) 约 22.5 万、[Codex](https://github.com/openai/codex) 约 13.3 万、[Gemini CLI](https://github.com/google-gemini/gemini-cli) 约 10.9 万。下表链接固定到实际检查过的提交。

| 项目 | 上游源码行为 | AI Studio 中的对应行为 |
|------|--------------|-----------------------|
| [OpenAI Codex](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/parallel.rs) | 按工具是否支持并行决定获取读锁或写锁 | 连续只读调用可重叠执行，写入和终端命令按原顺序执行。每批最多同时运行 4 个只读工具，这是 AI Studio 的本地上限。 |
| [Gemini CLI 调度器](https://github.com/google-gemini/gemini-cli/blob/1fe22af5f800d8c3024e9968d35bb75bd09e6b79/packages/core/src/scheduler/scheduler.ts#L487-L550) | 将连续可并行的调用分组；执行前评估权限并处理确认 | 主、子智能体共用连续调用分组。需要确认的命令等待用户决定，取消后终止等待。模型协议解析由 AI Studio 自行实现。 |
| [OpenCode 工具上下文](https://github.com/anomalyco/opencode/blob/fc7e4cf93e660ad5ddabb0c48ecc99e934ebfe95/packages/opencode/src/session/tools.ts#L55-L94) | 在权限请求中关联会话、消息和工具调用 ID | 桌面审批绑定本次请求，工具记录与变更按会话保存。旧会话的审批无法放行新请求。 |

主智能体和子智能体共用 `src/vs/platform/ai/common/toolRuntime.ts`。只读计划模式在执行器中限制可用工具。运行时也会拒绝无效参数，并将拒绝或失败关联到对应的调用。

### Agent 核心修复与 OpenCode V2 验证（2026-11-06）

- API 地址、接口类型、命令审批等配置从用户/策略层读取，工作区不能覆盖。密钥按 provider + origin 存储；认证模型请求拒绝重定向，安全存储失败不回退到明文。
- 无目标绑定的旧全局密钥会保留，但不会自动猜测所属地址；升级后如模型提示未配置密钥，请在模型表单为目标地址重新保存。用户级旧 `ai.apiKey` 与明确配置的地址可迁移。
- 主、子智能体按实际消息和工具定义计算请求预算，成功摘要后替换当前消息；失败或取消保留原历史。`ai.modelContextTokens` 为用户填写的模型窗口，默认 128k，尚未自动探测服务端窗口。
- 异常断流、输出上限和不支持的停止原因按失败处理；读取、写入与搜索复用文件服务真实路径检查，防止常见符号链接外逃，并统一敏感文件排除策略。这些检查不替代 OS 沙箱或文件系统竞态防护。

OpenCode 使用独立目录内锁定的 **`@opencode/sdk@2.2.5`** 验证，直接运行其会话、权限、工具和 SQLite 实现。宿主采用 Electron utility process，HTTP 请求接入 Electron 系统代理栈；未支持的 Node 网络出口在验证进程中明确拒绝。当前默认 Agent 仍使用原运行时，未把 SDK 加入主应用依赖。

```bash
npm run test:ai
npm run compile
npm run test:ai:network
npm ci --prefix test/integration/ai-opencode --ignore-scripts --legacy-peer-deps
npm run test:ai:opencode
```

[网络回归说明](test/integration/ai-network/README.md)与 [OpenCode 验证说明](test/integration/ai-opencode/README.md)列出覆盖范围、复跑条件和平台限制。报告分别写入 `.build/ai-network/report.json`、`.build/opencode-validation/report.json`。后续整核迁移需继续接通工作台审批/审查 UI，并验收 MCP、终端/子进程网络、OS 沙箱及跨平台打包。

已知待完善项：

| 优先级 | 内容 |
|--------|------|
| 高 | 编译稳定性、Windows 原生模块绑定 |
| 高 | OS 沙箱接入、文件系统竞态防护、命令执行策略收敛 |
| 中 | 扩大跨平台审查和回滚测试、优化大工作区索引 |
| 低 | 扩展视图样式适配、错误边界、可访问性 |

---

## 开发计划

### 短期（1-3 个月）：工程稳定性与安全基线

**构建与环境修复**

macOS arm64 已验证完整编译和桌面启动。Windows 和 Linux 的构建与启动仍需验证，重点检查原生模块绑定与 Electron ABI 是否匹配。

**安全加固**

工具执行器（`toolExecutor.ts`）是所有 AI 行为的边界层，安全投入应优先于功能开发。三项高优先级工作：

1. **路径包容性检查**：`_resolvePath()` 需统一拒绝 `../` 越界路径和非 workspace 绝对路径，仅允许经用户明确授权的外部路径访问。
2. **命令注入防护**：本地文件搜索通过独立参数启动 `rg`。网页抓取和搜索通过桌面网络栈发起 HTTP 请求。后续新增工具也需验证参数边界和命令审批策略。
3. **密钥存储迁移**：`ai.apiKey` 应从普通配置项（`aiConfigurationNode`）迁移至 VS Code SecretStorage 或已有的 `AIKeychainService`，避免密钥进入 settings sync、日志或截屏。

**Diff 引擎修复**

已补充写入、撤销、重启恢复、重复内容、CRLF 以及未保存编辑的回归检查。后续重点检查 Windows 路径与多根工作区中的实际审查体验。

**回归测试**

运行 `npm run test:ai` 可验证文件操作、网页工具、模型流式解析、命令审批、子智能体及审查状态恢复。真实桌面验收还需验证菜单、输入、窗口恢复和编辑器差异视图。

### 中期（3-6 个月）：架构收敛与产品化

**Copilot / Agent Host 边界决策**

桌面端的 `gulp compile` 过滤了 Agent Host 的实现文件，保留工作台所需的空状态桩。单独对 `src/tsconfig.json` 做类型检查时，TypeScript 仍会通过其他模块的导入加载部分 Agent Host 源文件。

当前策略：保留 agentHost 源码在仓库中（便于后续提取为独立扩展），编译期隔离。所有 AI 运行时链路（Agent Runtime、Tool System、LLM Provider）走自研体系，不依赖 Copilot/AgentHost 基础设施。

**层级边界整理**

`platform/ai/browser/aiAgentService.ts` 当前反向依赖 `workbench/contrib/aiDiffApply/browser/diffStore.ts`，打破了 VS Code 的 platform/workbench 分层约定。需要将 diff store 接口下沉至 `platform/common` 或建立平台级 DI 注册，workbench 层仅保留 UI 和命令贡献。

**索引架构升级**

当前 `IndexBuilder` 在服务初始化时自动对全工作区执行 `fullIndex`，对于大型仓库无索引状态检查、无进度反馈、无取消机制、无并发限制。需要改造为：

- 持久化索引状态，启动时检查增量更新，避免每次都重建
- 引入 `files.exclude` / `search.exclude` / 自定义 include-exclude 模式
- 文件数上限、单文件大小上限、API 调用频率限制（rate limiter）
- 文件变更监听，增量增删索引条目，而非全量重建
- 取消 token 传递，支持用户中断长时间索引任务

**Agent 结果模型**

AgentService 当前消息循环将工具结果、过程步骤与最终回复混入同一消息流，缺少清晰的输出分层。建议定义 `AgentRunResult` 数据结构，明确区分：finalMessage（用户可见最终回答）、changedFiles（受影响的文件列表）、plan（执行计划）、steps（各步骤详情及状态）、errors（错误汇总）、usage（token 消耗统计）。Chat Agent 仅将 `finalMessage` 渲染为正式回答，其余通过 Plan View / Timeline 展示。

**模型配置体验**

桌面已提供模型配置表单。后续工作包括：

- 在现有 Provider 类型选择表单中增加连接测试
- API 端点联通性探测
- 模型列表拉取与选择（兼容 OpenAI / Anthropic 模型列表 API）
- 敏感信息（Key）仅通过 SecretStorage 输入，不在 settings UI 中明文展示

### 长期（6-12 个月）：深度 AI 集成与生态

**Agent 能力扩展**

- Multi-turn 记忆：跨会话持久化对话上下文，基于项目维度组织记忆条目
- Sub-agent 模型：主 Agent 可委派子 Agent 处理独立子任务，并行执行
- 自定义 Tool 机制：允许用户以扩展形式注册自定义工具（REST API 调用、数据库查询、自定义 CLI 等）
- 人机协作模式：Agent 在执行关键操作（如删除文件、执行破坏性命令）前请求用户确认

**Codebase Intelligence 深化**

- AST-aware chunking：基于 Tree-sitter 按语法边界切块，替代当前简单按行切分
- Symbol graph 索引：构建跨文件符号引用关系图，支持"谁调用了这个函数"语义查询
- 增量索引：监听文件保存事件，仅重新索引变更文件及其受影响的关联文件
- 多语言 Embedding 模型适配：根据项目语言自动选择合适的 embedding 模型

**协作与共享**

- Agent 会话导出：将完整对话、执行计划与代码变更导出为可分享的格式
- Prompt 模板市场：社区可贡献和发布针对特定场景（重构、代码审查、生成测试、迁移升级等）的 prompt 模板
- Team-level 记忆共享：团队级 AI 记忆，共享项目约定、架构决策、代码风格偏好

**扩展生态兼容**

- 确保 AI Studio 的 Agent/Provider/Tool 扩展接口与 VS Code upstream 扩展 API 兼容
- 提供 AI Studio 专属扩展 API：`ai.registerToolProvider`、`ai.registerLLMProvider`、`ai.registerAgentMiddleware`
- 迁移第三方 Cursor/Copilot 扩展的场景经验到 AI Studio 生态

---

## 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | 技术债务修复：竞态条件、取消传播、ToolExecutor 复用、快照/回滚、索引一致性、多根工作区、usage 提取 | ✅ 完成 |
| Phase 1 | 基础能力补齐：CLAUDE.md 自动发现、WebFetch+WebSearch、系统提示词重写、图片/PDF 读取、AgentSession 持久化 | ✅ 完成 |
| Phase 2 | Agent 编排核心：子 Agent 系统、Task 依赖图、SendMessage、验证、用户记忆 | 已接入运行时；跨平台 worktree 流程仍需实测 |
| Phase 3 | 交互与计划：AskUserQuestion、EnterPlanMode/ExitPlanMode、自定义斜杠命令 | 已接入提问与计划审批；斜杠命令的桌面交互仍待验收 |
| Phase 4 | 补充完善：Cron、Skill 工具、Workflow 引擎、NotebookEdit、Artifact 系统 | 待实施 |

---

## 优化方向

### 架构层面

1. **模块解耦**：消除 platform 层对 workbench 层的反向依赖，通过 DI 注入或事件总线解耦。将共享类型（AgentResult、ToolDefinition、DiffRecord 等）下沉至 `platform/common`。
2. **插件化 Provider**：将 LLM Provider 从内置实现改为可插拔扩展机制，第三方开发者可发布自己的 Provider 扩展，不影响核心代码路径。
3. **多进程索引**：将 embedding 计算和索引构建迁移至 Worker/子进程，避免阻塞 UI 主线程和 Extension Host。

### 性能层面

1. **增量索引**：当前每次启动全量重建索引，需改为增量更新。利用文件 mtime + hash diff 判断变更，仅重索引实际变更文件。
2. **Embedding 批量化**：将逐文件 API 调用合并为批量请求，减少 API 往返次数和速率限制触发概率。
3. **上下文裁剪策略**：Agent 消息窗口随执行步数增长而膨胀。引入滑动窗口 + 摘要压缩机制，在超出 token 限制前自动对历史消息执行摘要归并。

### 安全层面

1. **权限分级**：将工具按风险等级分类（只读 / 写文件 / 执行命令 / 网络访问），提供细粒度的用户审批策略：自动允许 / 每次确认 / 禁止。
2. **沙箱执行**：terminal 工具支持 Docker/podman 容器内执行，以进程级隔离替代当前的白名单 + 超时方案。
3. **审计日志**：记录 Agent 所有文件变更和命令执行的完整轨迹，支持事后回溯。

### 体验层面

1. **流式输出统一**：Agent 规划、工具执行、最终回答三个阶段统一采用流式输出，降低用户感知等待时长。
2. **内联建议**：参考 Cursor 的 inline edit 体验，Agent 输出直接内联到编辑器文本中，以幽灵文本（ghost text）或即时预览方式呈现，支持 Tab 接受。
3. **错误自愈可视化**：当 Agent 检测到执行错误（编译报错、测试失败、lint 告警）并自动修复时，以 diff 动画方式展示"修复前 → 修复后"的变化。
4. **项目感知配置**：支持 `.ai-studio/config.json` 项目级配置，定义该项目的常用 prompt 模板、禁止的工具、偏好的模型等，随项目代码仓库提交和共享。

### 工程层面

1. **CI/CD**：为自研 AI 模块建立独立的 CI 流水线，覆盖编译、类型检查、单元测试、集成测试。
2. **端到端测试**：构建 E2E 测试框架，模拟"用户给定自然语言任务 → Agent 规划 → 执行 → 验证文件系统状态"的完整链路。
3. **性能基准**：建立 Agent 执行延迟、索引构建耗时、内存占用的回归基准，防止性能退化。

---

## 许可

基于 [Code - OSS](https://github.com/microsoft/vscode)（MIT License）二次开发。自研部分沿用 [MIT License](LICENSE.txt)。
