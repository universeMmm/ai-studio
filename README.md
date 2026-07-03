# AI Studio — 基于 VS Code 的 AI-Native 代码编辑器

AI Studio 是 [Code - OSS](https://github.com/microsoft/vscode) 的深度定制分支，将 VS Code 改造为 AI-first 的智能编程环境。核心目标是：**完全使用用户自定义模型，不绑定任何商业 AI 服务**。

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

为 AI 提供直接操作系统与代码的能力。已实现工具：

| 工具 | 说明 |
|------|------|
| `file.read` | 读取工作区文件内容 |
| `file.edit` | 编辑文件（统一 diff 格式） |
| `terminal.run` | 执行终端命令（含超时、输出截断、白名单机制） |
| `workspace.search` | 工作区内容搜索（ripgrep） |
| `git.apply` | Git 操作 |

代码路径：`src/vs/platform/ai/browser/toolExecutor.ts`

### Codebase Index

让 AI 理解项目的全局语义。实现文件分块抽取、Embedding 向量化、HNSW 近似搜索，配合 `rg` 关键字搜索作为 fallback，构建混合检索能力。

代码路径：`src/vs/platform/ai/browser/aiIndexService.ts`、`indexBuilder.ts`

### LLM Provider Layer

统一模型接口抽象层，支持：

- OpenAI API（及任意兼容接口，如 Ollama、vLLM、LiteLLM 等）
- Anthropic Claude API
- 自定义 HTTP API

通过 `ai.apiBase` 配置任意兼容端点，模型选择权完全在用户手中。

代码路径：`src/vs/platform/ai/browser/aiModelService.ts`

### Patch Engine

AI 生成的代码变更以 unified diff 方式应用至文件系统。提供完整的审查流程：预览差异、逐条接受/拒绝、批量操作、文件级回滚。所有变更加持化至 `.ai-studio/diffs.json`。

代码路径：`src/vs/workbench/contrib/aiDiffApply/`

### Agent UI

替换 VS Code 原生 Chat Panel，新增：

- Agent Chat — AI 对话主入口
- Plan View — 结构化展示执行计划
- Execution Timeline — 步骤级执行日志
- Diff Preview — 代码变更审查面板

代码路径：`src/vs/workbench/contrib/aiChat/`、`aiContextView/`、`aiStatusBar/`

---

## 目录结构

```
src/vs/platform/ai/                  AI 平台服务层
  browser/
    aiAgentService.ts                   Agent 循环核心
    aiModelService.ts                   LLM Provider 管理
    aiIndexService.ts                   语义索引服务
    toolExecutor.ts                     工具执行器
    indexBuilder.ts                     索引构建器
src/vs/workbench/contrib/
  aiChat/                               AI Chat 面板
  aiDiffApply/                          Diff 审查、接受/拒绝、回滚
  aiContextView/                        AI 上下文视图
  aiStatusBar/                          AI 状态栏指示器
```

---

## 快速开始

**环境要求**：Node.js 20+、Rust（CLI 编译用）、4 核 CPU、8 GB RAM

```bash
npm install
npm run compile
./scripts/code.sh          # macOS / Linux
scripts\code.bat           # Windows
```

启动后在设置中搜索 `ai.`，配置模型连接：

| 配置项 | 说明 |
|--------|------|
| `ai.apiType` | 模型类型：`openai` / `anthropic` / `custom` |
| `ai.apiBase` | API 端点地址 |
| `ai.apiKey` | API 密钥 |
| `ai.modelId` | 模型 ID |

---

## 项目状态

当前处于 **早期 MVP 阶段**。核心链路（Chat → Agent 规划 → 工具执行 → 多文件编辑 → Diff 审查）已跑通。

已知待完善项：

| 优先级 | 内容 |
|--------|------|
| 高 | 编译稳定性（TypeScript 严格检查）、Windows 原生模块绑定 |
| 高 | 路径越界防护、命令注入加固、API Key 安全存储迁移 |
| 中 | 测试覆盖率、Diff 回滚语义修正、索引性能优化 |
| 低 | UI 样式统一、错误边界、可访问性 |

---

## 开发计划

### 短期（1-3 个月）：工程稳定性与安全基线

**构建与环境修复**

当前 `npm run compile` 存在 TypeScript 严格模式报错（`indexBuilder.ts` 未使用常量），以及 Windows 平台原生模块（`@vscode/spdlog`、`@vscode/windows-mutex`、`native-keymap`、`node-pty`）绑定缺失导致 `scripts/code.bat` 启动失败。短期首要目标是打通 Windows/Linux/macOS 三端的完整构建与运行链路，补齐原生模块的 Electron ABI rebuild 流程。

**安全加固**

工具执行器（`toolExecutor.ts`）是所有 AI 行为的边界层，安全投入应优先于功能开发。三项高优先级工作：

1. **路径包容性检查**：`_resolvePath()` 需统一拒绝 `../` 越界路径和非 workspace 绝对路径，仅允许经用户明确授权的外部路径访问。
2. **命令注入防护**：`_searchPattern()` 和 `AIIndexService._keywordSearch()` 当前以字符串拼接方式构造 `rg` 命令，需改为 `spawn('rg', args[], { shell: false })` 结构化参数传递，彻底消除 shell metacharacter 注入面。
3. **密钥存储迁移**：`ai.apiKey` 应从普通配置项（`aiConfigurationNode`）迁移至 VS Code SecretStorage 或已有的 `AIKeychainService`，避免密钥进入 settings sync、日志或截屏。

**Diff 引擎修复**

`DiffStore.rejectHunk()` / `rejectAll()` 中存在持久化缺失问题（`return` 提前退出导致 `_persist()` 未被调用）。`DiffApplyController._reverseEdit()` 使用 `String.replace()` 而非按 `modifiedStartLine/modifiedEndLine` 精确行范围替换，在重复文本场景下回滚结果不可靠。需要重写行范围替换逻辑并在未打开文件路径与已打开编辑器路径下保持一致。

**测试补齐**

自研 AI 模块（`platform/ai`、`workbench/contrib/ai*`）现有测试覆盖率极低。优先补齐：路径越界拒绝测试、敏感文件拒绝测试、`searchPattern` shell 注入拒绝测试、write/edit diff 持久化测试、rejectHunk/rejectAll 持久化测试、行范围回滚测试、CRLF 文件回滚测试、Provider 错误与流式解析测试、IndexBuilder 路径处理测试。

### 中期（3-6 个月）：架构收敛与产品化

**Copilot / Agent Host 边界决策**

当前代码库中同时存在 Copilot、Agent Host、Claude Agent SDK 相关路径和依赖（`src/vs/platform/agentHost/node/claude/`、`src/vs/platform/agentHost/node/copilot/`、`@anthropic-ai/claude-agent-sdk`），与设计文档所述"完全移除商业 AI 依赖"目标存在张力。中期需明确产品决策：

- 方案 A：保留 Agent Host / 商业 AI 基础设施作为可选能力，在产品层隐藏入口，未来以扩展形式加载。
- 方案 B：彻底移除相关模块和依赖，全面切换至自研 Provider 体系。

方案 A 可快速获得更完整的 Chat/Agent 交互体验（复用 VS Code upstream 现有交互格式、inline chat、agent session 管理），代价是在产品层引入商业依赖。方案 B 自主可控程度最高但工程量大，且会失去 VS Code upstream 的 Agent 交互基础设施更新。

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

Provider 配置当前仅通过 settings JSON 直接编辑，缺少 GUI 配置面板。中期需提供：

- Provider 类型选择与连接测试
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

| 阶段 | 时间 | 内容 | 状态 |
|------|------|------|------|
| Phase 1 | 短期 | 移除 Copilot 依赖，替换 Chat 服务体系 | 进行中 |
| Phase 2 | 短期 | Agent Runtime + Tool System 完善与安全加固 | MVP 完成，加固中 |
| Phase 3 | 短期 | 编译稳定与测试补齐 | 待启动 |
| Phase 4 | 中期 | 架构收敛、层级边界整理、索引升级 | 规划中 |
| Phase 5 | 中期 | 模型配置 GUI、Agent 结果模型规范化 | 规划中 |
| Phase 6 | 长期 | Sub-agent、自定义 Tool、AST-aware 索引 | 规划中 |
| Phase 7 | 长期 | 协作共享、扩展生态、Prompt 市场 | 规划中 |

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
