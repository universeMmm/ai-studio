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

按工作区目录分别建立代码块索引，合并向量检索和 `rg` 关键词检索结果。桌面渲染进程通过 IndexedDB 保存向量和文件指纹；在 Node 环境中使用 SQLite，小索引可选 HNSW 加速，大索引使用可取消的精确检索。启动时先比较 mtime/size，再按需比较内容 hash，未改变的文件不重新请求 Embedding。文件保存、增删、重命名和忽略规则变化会自动维护索引。

任务详情的「上下文 → 代码索引」提供开启/关闭、取消/继续和进度显示；命令面板也可执行对应操作。关闭索引会停止监听、扫描及 Embedding 请求，已有持久化数据保留；取消后暂停自动维护，点击继续时补齐期间的变更。关键词搜索仍可单独使用。

| 配置项 | 默认值与作用 |
|--------|------------|
| `ai.index.enabled` | `true`，控制索引生命周期 |
| `ai.index.maxFiles` | `10000`，每个目录按路径排序选取的候选文件上限 |
| `ai.index.maxMemoryMB` | `256`，每个目录索引条目的估算内存预算（MiB），包含向量、文本和对象开销；不是整个进程 RSS 上限 |
| `ai.index.batchSize` | `16`，单次请求的代码块上限，可跨文件合并 |
| `ai.index.requestInterval` | `200`，同一目录请求的最小间隔，单位毫秒 |
| `ai.index.include` | `["**/*"]`，允许索引的相对路径 glob |
| `ai.index.exclude` | `[]`，额外排除的相对路径 glob |

索引遵循 Git 忽略规则和 `files.exclude` / `search.exclude` 中值为 `true` 的规则，固定排除依赖目录、索引数据库及敏感文件。单文件仍限制为 100 KiB / 1000 行；代码块及请求另设字符上限。达到内存预算时停止新增条目并显示提示；提高预算可补齐，降低预算会裁剪可重建的持久化索引。失败不会提交新的文件指纹，重试可继续处理。

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

运行 AI 模块的离线回归测试可使用 `npm run test:ai`。提交前运行 `npm run check:ai`，依次检查依赖锁文件与桌面运行时边界、完整 `src` 类型检查和 AI 回归。测试不需要真实模型密钥；模型协议测试会启动仅监听本机的 HTTP 模拟服务。

在 macOS 上运行 `npm run package:mac -- --version=1.122.0-preview.1` 可构建当前处理器架构的应用和 DMG。输出位于 `.build/release/`，包含安装包及 SHA-256 校验文件；磁盘镜像内提供应用与 `Applications` 快捷方式。脚本复用现有生产构建流程和 Electron 签名工具，不包含用户配置或模型密钥。已有完整构建可用 `--skip-build` 只生成磁盘镜像。

构建后可运行 `npm run test:ai:package` 验证正式应用的独立启动、本地模型流式请求、文件工具、模型列表、系统代理及中文缓存。测试使用临时用户配置和本机模拟服务；设置 `STUDIO_TEST_APP` 可指定从 DMG 复制出来的应用可执行文件。

未设置 `CODESIGN_IDENTITY` 时使用临时签名，安装包未经 Apple 公证，macOS 首次运行可能需要在「系统设置 → 隐私与安全性」中允许打开。Developer ID 签名和公证需自行配置 Apple 开发者凭据。Agent Host 公共协议的类型缺失已修复；类型检查、AI 回归与正式应用构建分别验证，安装包验收仍使用 `test:ai:package`。

桌面首次启动默认使用简体中文。核心菜单、编辑器命令、设置说明及内置扩展的译文随项目分发，可断网启动。上游译文来自与编辑器版本匹配的 [Microsoft 简体中文语言包](https://github.com/microsoft/vscode-loc/tree/6328467f46f70a56566410dc5dcce9d6e2fec2f9/i18n/vscode-language-pack-zh-hans)。使用 `./scripts/code.sh --locale=en` 可显式选择英文核心界面。

启动后使用标题栏「设置 → 管理模型」，填写配置名称、模型 ID、接口类型和 API 地址。默认界面围绕任务、项目和文件展开；「设置 → 高级模式」可显示终端、调试、编辑器工具栏与完整设置。切换模式保留未保存的文件、终端进程和原有布局，不改写用户的编辑器展示设置。

「设置 → 技能与工具」及输入框左侧「+」提供技能、插件和 MCP 连接入口：

- 技能复用已有的 `SKILL.md` 发现机制；可添加本机技能集合目录、创建技能，并将技能附加到本轮会话。
- 插件复用现有插件清单与启停机制；通过本机插件文件夹添加技能和 MCP 工具包。
- MCP 复用现有连接、信任、授权与工具服务，连接成功的工具进入主 Agent 的调用链；停用的工具不会继续执行。只读计划模式暂不开放 MCP 工具。
- 网络继续跟随系统代理，不增加应用内代理配置。第三方本机 MCP 程序自身发起的网络请求由该程序负责，应用不能替外部进程承诺代理行为。

文件可以拖入输入框或通过「+」添加，附件以缩略图卡片展示。macOS/Windows 文档预览复用系统缩略图；不支持的格式或平台显示文件类型卡片。预览不会把文档转成模型输入：文本与图片按已有附件规则发送，PDF、Word 等二进制文件目前仅发送路径引用。点击卡片右上角「×」会从后续请求中移除该附件。

技能与 MCP 的隔离回归可使用 `npm run test:ai:capabilities`，详见 [测试说明](test/integration/ai-capabilities/README.md)。索引的真实桌面回归使用 `npm run test:ai:index`，覆盖原生文件监听、重启复用、开关及取消，详见 [索引测试说明](test/integration/ai-index/README.md)。

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
| 高 | Windows/Linux 发布打包、签名与完整编辑器 UI 验收；索引原生链路和开发版启动已通过托管 CI |
| 高 | OS 沙箱接入、文件系统竞态防护、命令执行策略收敛 |
| 中 | 扩大跨平台审查和回滚测试、远程/虚拟文件系统与百万文件规模验证 |
| 低 | 扩展视图样式适配、错误边界、可访问性 |

---

## 开发计划

2026-11-09 工程基线修复状态（本机 macOS arm64 与 GitHub 托管三平台）：

| 工作项 | 状态与验证 |
|--------|------------|
| 类型检查 | 已完成：`npm run compile-check-ts-native` 从 175 条错误降至 0；未降低严格类型检查要求 |
| 依赖与构建清理 | 已完成：npm 重新生成锁文件，移除 Copilot SDK/平台包；删除旧 Azure 下载步骤与 macOS 打包例外；保留扩展兼容所需的 `@vscode/copilot-api` |
| AI 回归 | 本轮 `npm run check:ai` 通过，304 项测试；此前工程基线的 270 项已在全新临时目录离线安装后复跑通过 |
| 桌面集成 | 三平台完整编译与索引回归各 20 项通过；macOS 技能/MCP 回归 10 项通过，干净环境自动创建报告目录 |
| 索引增量化与性能保护 | 已完成：持久化文件指纹、批量请求与间隔控制、文件上限、监听合并、开关及取消/继续；1000 文件样例为 63 次请求，未变更扫描和重启均为 0 次新增请求 |
| 十万文件压测 | 已完成：托管三平台各四组、每平台 32 项检查全部通过，覆盖十万条 1536/3072 维向量、SQLite、真实十万文件、全文快照、内存释放与取消 |
| Windows/Linux 索引回归 | 已完成：托管 Windows 2022 / Ubuntu 22.04 各 20 项真实桌面检查通过，覆盖原生 ABI、监听、路径差异、持久化关闭及取消响应 |
| CI 接入 | 已完成：提交 `1b5f1f8` 的[托管 CI 六项任务全部通过](https://github.com/universeMmm/ai-studio/actions/runs/42595379893)，包含三平台完整压测；报告已核对提交、ABI、运行标识、源码指纹与检查结果 |

CI 配置位于 [.github/workflows/ai-ci.yml](.github/workflows/ai-ci.yml)，由 push、pull request 或手动触发。三平台核心任务使用不执行安装脚本的干净依赖安装，运行依赖边界和类型检查；Ubuntu/macOS 执行完整 AI 回归，Windows 执行 37 项索引专项回归。三平台桌面任务执行完整安装、编译、Electron 准备和真实工作台索引回归；Linux 使用 Xvfb，macOS 另外执行技能/MCP 回归，并按 runner 分别保存报告。手动运行时可启用 `index_stress`，三平台各执行完整四组十万文件压力测试；`codex/index-stress-*` 验证分支也会触发，并上传分平台报告及指标摘要。公网搜索、安装包和 OpenCode SDK 验证仍为独立验收，不计入此工作流的通过范围。

### 短期（1-3 个月）：工程稳定性与安全基线

**构建与环境修复**

本机 macOS arm64 及托管 Ubuntu/Windows/macOS 已验证类型检查、完整桌面编译和索引集成。公共类型恢复取自本仓库基线 `499704b`：恢复协议快照和公共辅助代码，不恢复宿主进程实现或注册；Agent Host 启用函数仍固定返回 false。依赖检查还会遍历桌面入口的静态运行时导入，拒绝重新接入被隔离的宿主模块。托管三平台均直接加载并执行 SQLite、Parcel watcher 和内置 ripgrep，使用 Electron 39.8.8 / 原生 ABI 140，未以纯内存回退代替原生验收。

**安全加固**

工具执行器（`toolExecutor.ts`）是所有 AI 行为的边界层，安全投入应优先于功能开发。三项高优先级工作：

1. **路径包容性检查**：已实现工作区边界、真实路径和敏感文件检查；外部路径授权、OS 沙箱与文件系统竞态防护仍待完成。
2. **命令注入防护**：本地文件搜索通过独立参数启动 `rg`。网页抓取和搜索通过桌面网络栈发起 HTTP 请求。后续新增工具也需验证参数边界和命令审批策略。
3. **密钥存储迁移**：新模型配置已使用 SecretStorage，按 provider/origin 绑定，并迁移可确定目标的旧用户密钥；旧 `ai.apiKey` 兼容配置仍存在，尚未完全移除普通设置中的密钥入口。

**Diff 引擎修复**

已补充写入、撤销、重启恢复、重复内容、CRLF 以及未保存编辑的回归检查。后续重点检查 Windows 路径与多根工作区中的实际审查体验。

**回归测试**

运行 `npm run test:ai` 可验证文件操作、网页工具、模型流式解析、命令审批、子智能体及审查状态恢复。真实桌面验收还需验证菜单、输入、窗口恢复和编辑器差异视图。

### 中期（3-6 个月）：架构收敛与产品化

**Copilot / Agent Host 边界决策**

桌面端的 `gulp compile` 继续过滤 Agent Host 实现。仓库恢复保留的适配器和测试所引用的公共协议类型与辅助代码；工作台继续使用停用宿主后的本地实现。公共协议的恢复不代表该运行时重新启用。

当前策略：保留 agentHost 源码在仓库中（便于后续提取为独立扩展），编译期隔离。所有 AI 运行时链路（Agent Runtime、Tool System、LLM Provider）走自研体系，不依赖 Copilot/AgentHost 基础设施。

**层级边界整理**

`platform/ai/browser/aiAgentService.ts` 当前反向依赖 `workbench/contrib/aiDiffApply/browser/diffStore.ts`，打破了 VS Code 的 platform/workbench 分层约定。需要将 diff store 接口下沉至 `platform/common` 或建立平台级 DI 注册，workbench 层仅保留 UI 和命令贡献。

**索引架构升级**

2026-11-09 已完成本地工作区的增量索引与大工作区性能保护：

- [x] IndexedDB / SQLite 原子保存向量和 mtime/size/hash/Embedding 配置指纹；未变更文件跳过读取与请求，仅触碰时间戳时通过 hash 复用向量。旧格式或服务地址变化会使对应缓存失效。
- [x] 接入 `files.exclude` / `search.exclude` 的无条件排除规则，以及 `ai.index.include` / `ai.index.exclude`；遵循 Git 忽略规则并排除敏感路径与符号链接外逃。
- [x] 默认每目录最多 10000 个候选文件，跨文件合并每批最多 16 个代码块，单批文本最多 32000 字符；后台任务跨目录串行，同一目录默认请求间隔 200 ms，请求超时 30 秒。
- [x] 文件服务递归监听、300 ms 事件合并和待处理队列上限；修改与删除按文件更新，新增文件/目录和忽略规则变化触发增量扫描，保持忽略规则与文件上限一致。语义搜索仅保留 top-K 候选，并定期让出事件循环。
- [x] `ai.index.enabled` 实际控制扫描、监听与请求；取消信号贯通文件读取、ripgrep IPC、模型初始化等待和 Embedding fetch。界面及命令支持开关、取消、继续和数量进度；错误保留已提交版本，手动更新可重试。
- [x] `npm run check:ai` 的 297 项回归通过；`npm run compile` 零错误；`npm run test:ai:index` 已接入三平台 CI，本机 20 项真实桌面检查通过，报告为 `.build/ui-redesign/studio-index-runtime-report.json`。

本机 macOS arm64 的 1000 文件、本地两维 Embedding 测试样例使用 63 次请求，初次构建约 1.2 秒、未变更扫描约 0.13 秒，重启无新增 Embedding 请求。这些数据用于固定样例回归，不代表公网模型吞吐量。

2026-11-09 补齐十万级压测，并修复压测暴露的问题：

- [x] 检索取消贯通 Agent/工具调用、Embedding、关键词搜索及精确向量扫描；按时间片让出事件循环，使用不受浏览器嵌套定时器 4 ms 限制的任务调度，缓存向量范数。较大的索引不在查询线程同步构建 HNSW 图。
- [x] IndexedDB / SQLite 改为每页最多 16 个文件分批加载，移除 SQLite 持久化层保留的整份向量映射；重载支持取消，关闭后释放向量引用。
- [x] 新增 `ai.index.maxMemoryMB`（默认每目录 256 MiB），在写入及重载时执行预算检查；排除/失效条目先过滤，不挤占有效数据的预算。此预算约束索引条目估算占用，进程 RSS 还包含工作台、加载页和分配器开销。
- [x] 文件枚举与路径排序分批处理；文件清单独立使用 64 MiB 上限，普通命令仍为 10 MiB，按 UTF-8 字节截断并标记不完整输出。十万长路径文件的 17.2 MiB 清单已完整验证，截断清单不会触发索引清理。
- [x] 新增 `npm run test:ai:index:stress`，4 组样例串行在独立进程中执行，保留源码指纹、内存、P50/P95 与取消数据；已接入三平台 CI 的手动 `index_stress` 选项和验证分支触发。当时的 11 项桌面索引回归复跑通过，现已扩展为每平台 20 项。

2026-11-09 补齐跨平台索引回归入口：

- [x] 测试直接启动各平台 Electron 可执行文件，避免 Windows 调用 `.sh` / `.bat`；Linux CI 安装原生构建依赖并通过 Xvfb 启动。
- [x] 修复 Windows `.\` 路径前缀在精确 include 匹配中的规范化顺序；增加中文/空格路径和大小写重命名回归。
- [x] SQLite 关闭返回可等待的 Promise，串行等待写入与句柄释放；增加立即删除数据库目录、原生重载取消/恢复及子进程树实际停止的检查。
- [x] 本机 macOS：297 项完整 AI 回归、30 项索引专项、20 项真实桌面检查通过，完整编译零错误。HTTP 取消约 23 ms，原生命令进程树停止约 1 ms，SQLite 重载取消约 0.5 ms。关闭机制及启动器修改后，4 组十万文件压测再次全部通过。
- [x] [托管 CI 六项任务全部通过](https://github.com/universeMmm/ai-studio/actions/runs/42574093326)，代码提交 `8a45038`。Ubuntu/macOS 各通过 297 项 AI 回归，Windows 通过 30 项索引专项；三平台桌面各 20 项，macOS 技能/MCP 另有 10 项。
- [x] 托管验证发现并修复：大小写敏感文件系统上的 Agent Host 排除规则、测试夹具依赖系统 `rg`、Windows 应用目录末尾反斜杠的启动参数问题、已退役的 macOS 14 runner、重复下载 Electron 与临时网络错误、全新环境的报告目录初始化。下载仍校验 SHA-256，最多重试两次临时网络错误。

上轮常规托管样例使用 1000 个真实文件、本地两维 HTTP Embedding fixture，以及 512 个 3072 维 SQLite 条目；下表是本次运行的单次取消耗时，不是 P95 或公网模型性能：

| 托管平台 | HTTP 请求取消 | 进程树停止 | SQLite 重载取消 |
|---|---:|---:|---:|
| Windows 2022 x64 | 31.2 ms | 80.4 ms | 1.1 ms |
| Ubuntu 22.04 x64 | 22.0 ms | 2.7 ms | 1.5 ms |
| macOS 15 arm64 | 4.0 ms | 3.0 ms | 1.7 ms |

报告已存档在 `.build/ai-index-ci/42574093326/`；三平台均验证了 SQLite/Parcel/ripgrep 原生加载、增改删/目录删除/大小写重命名、Unicode/空格路径、开关与补偿、取消后恢复和数据库句柄释放。Windows/Linux 的完整十万文件压测现已通过，见下方本轮验收记录。

**托管十万文件压测（2026-11-09）**

- [x] 提交 `1b5f1f8` 的[托管 CI 六项任务全部通过](https://github.com/universeMmm/ai-studio/actions/runs/42595379893)：Windows 2022、Ubuntu 22.04、macOS 15 各通过四组完整压测、32 项检查，共 12 组。每组实际使用 100000 文件/条目，覆盖 1536/3072 维精确检索、SQLite、真实长路径工作区、IndexedDB 和取消恢复。
- [x] 修复完整索引每次关键词查询重新扫描所有文件的问题：持久化完整源文本，包含头部和注释；文本计入预算并随指纹原子更新。旧指纹补齐全文不重复请求向量；不完整索引、超大文件或待处理变更保留实时磁盘搜索。补充旧数据、预算、回退与长文本取消回归，Ubuntu/macOS 各通过 304 项 AI 测试，Windows 通过 37 项索引专项。
- [x] 修复原生依赖 Release API 未认证请求的 403，补齐超时进程清理、退出诊断、运行来源与源码指纹校验，以及分平台报告和指标摘要。
- [x] 托管 macOS 曾在 98401/100000 文件时触及固定 10 分钟夹具超时；改为两分钟无进度失败、配置触发的构建阶段 20 分钟、整个工作区 25 分钟的有界等待。检索、内存与取消门槛保持不变，最终三平台全部达标。

以下为真实十万文件、3072 维样例；内存是单个渲染进程峰值，扫描取消包含预定的 100 ms 等待：

| 托管平台 | 峰值内存 | 混合检索 P95 | 查询取消 | 扫描取消 | 重载取消 |
|---|---:|---:|---:|---:|---:|
| Windows 2022 x64 | 1861.2 MiB | 679.5 ms | 33.8 ms | 108.4 ms | 0.8 ms |
| Ubuntu 22.04 x64 | 2249.1 MiB | 417.4 ms | 34.0 ms | 100.8 ms | 0.6 ms |
| macOS 15 arm64 | 2102.5 MiB | 3888.0 ms | 36.1 ms | 102.3 ms | 0.3 ms |

报告存档在 `.build/ai-index-ci/42595379893/`，已逐份核对提交、平台、ABI、运行标识与源码指纹。三平台均通过 16 MiB 限额、关闭后的缓冲区释放、增量与重载零新增向量请求、七次查询使用完整全文快照及重载后全文可检索的检查。Windows/Linux 为约 16 GiB RAM 的 x64 运行器，macOS 为 7 GiB RAM 的 arm64 运行器；实例性能存在波动。完整 12 组指标、方法和门槛见[压测说明](test/integration/ai-index/stress/README.md)。

此前首次压测样例：本机 macOS arm64 / 16 GiB RAM，使用不共享缓冲区的稠密 Float32 合成向量。全量工作区压测显式设定 `maxFiles=100000`、`maxMemoryMB=2048`，并先用 16 MiB 预算验证能在 1174 个文件处停止新增：

| 场景（每组十万条） | 进程/渲染进程峰值 RSS | 检索 P95 | 查询取消总耗时 |
|---|---:|---:|---:|
| 1536 维精确检索 | 799 MiB | 151 ms | 18 ms |
| 3072 维精确检索 | 1456 MiB | 344 ms | 18 ms |
| 真实十万长路径文件、3072 维混合检索 | 1925 MiB | 1257 ms | 26 ms |

3072 维精确检索的修复前 P95 为 1175 ms，取消不会中止扫描；修复后 P95 为 344 ms，取消约 18 ms。SQLite 重载的进程峰值从 2396 MiB 降至 1393 MiB；关闭后的 external memory 从约 1174 MiB 降至约 1.9 MiB，修复向量引用滞留。RSS 可能由分配器暂时保留，不等同于仍持有可访问的向量。

真实工作区在提高预算后补齐十万文件约 112 秒（16 MiB 限额阶段单独计时），未变更扫描约 14.4 秒，取消后完整重载及增量扫描约 24.1 秒；扫描和重载均无新增 Embedding 请求。扫描在预定第 100 ms 请求取消后总计约 111 ms 结束，重载取消约 0.3 ms。渲染进程关闭索引后 backing storage 回到启动基线范围。数据来自固定本机样例，精确检索取 9 次、混合检索取 7 次（均含冷查询）；不代表公网模型吞吐量或相关性质量。

[压测方法与门槛](test/integration/ai-index/stress/README.md)，报告位于 `.build/ai-index-stress/report.json`。仍待推进：带 `when` 的兄弟文件条件排除、远程/虚拟工作区文件系统、百万级文件/更高维度。当前只为本地 `file` 工作区建立索引，清单超过 64 MiB 时会报错并保留已有索引；GitHub 托管三平台的常规索引回归已通过，压力测试的覆盖范围见上文。

**Agent 结果模型**

AgentService 当前消息循环将工具结果、过程步骤与最终回复混入同一消息流，缺少清晰的输出分层。建议定义 `AgentRunResult` 数据结构，明确区分：finalMessage（用户可见最终回答）、changedFiles（受影响的文件列表）、plan（执行计划）、steps（各步骤详情及状态）、errors（错误汇总）、usage（token 消耗统计）。Chat Agent 仅将 `finalMessage` 渲染为正式回答，其余通过 Plan View / Timeline 展示。

**模型配置体验**

桌面已提供模型配置表单及 OpenAI/Anthropic 模型列表拉取与选择。后续工作包括：

- 在现有 Provider 类型选择表单中增加连接测试
- 对选定模型发起受控推理验证；模型列表可达不等于推理接口可用
- 移除旧版普通设置密钥入口，完成仅通过 SecretStorage 输入的迁移

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
| Phase 2 | Agent 编排核心：子 Agent 系统、Task 依赖图、SendMessage、验证、用户记忆 | 已有同步委派与任务跟踪；并行/后台协作、项目记忆写入和跨平台 worktree 验收待完成 |
| Phase 3 | 交互与计划：AskUserQuestion、EnterPlanMode/ExitPlanMode、自定义斜杠命令 | 提问与计划审批已接入；斜杠命令仅注入提示词，候选与解析未接通 |
| Phase 4 | 补充完善：Cron、Skill 工具、Workflow 引擎、NotebookEdit、Artifact 系统 | 已有技能管理及会话附件入口；自主 Skill 工具及其他能力待实施 |

---

## 优化方向

### 架构层面

1. **模块解耦**：消除 platform 层对 workbench 层的反向依赖，通过 DI 注入或事件总线解耦。将共享类型（AgentResult、ToolDefinition、DiffRecord 等）下沉至 `platform/common`。
2. **插件化 Provider**：将 LLM Provider 从内置实现改为可插拔扩展机制，第三方开发者可发布自己的 Provider 扩展，不影响核心代码路径。
3. **多进程索引**：将 embedding 计算和索引构建迁移至 Worker/子进程，避免阻塞 UI 主线程和 Extension Host。

### 性能层面

1. **增量索引**：当前每次启动全量重建索引，需改为增量更新。利用文件 mtime + hash diff 判断变更，仅重索引实际变更文件。
2. **Embedding 批量化**：将逐文件 API 调用合并为批量请求，减少 API 往返次数和速率限制触发概率。
3. **上下文裁剪策略**：主/子 Agent 已接入预算检查与摘要压缩；后续优化长任务的摘要质量及模型窗口配置体验。

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

1. **CI/CD**：独立 AI CI 已配置，覆盖依赖边界、类型检查、AI 回归、桌面编译和技能/MCP 集成；三平台核心与桌面索引任务已在同一提交上全部通过。发布与签名仍独立处理。
2. **端到端测试**：已有桌面和安装包测试；继续扩展多步规划、文件修改/回滚与跨平台真实工作区验收。
3. **性能基准**：建立 Agent 执行延迟、索引构建耗时、内存占用的回归基准，防止性能退化。

---

## 许可

基于 [Code - OSS](https://github.com/microsoft/vscode)（MIT License）二次开发。自研部分沿用 [MIT License](LICENSE.txt)。
