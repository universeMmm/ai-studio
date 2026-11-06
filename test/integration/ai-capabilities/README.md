# 技能与 MCP 回归

先运行 `npm run compile`，然后运行 `npm run test:ai:capabilities`。需要允许本机 Electron 启动和 loopback 监听。

测试创建独立用户数据目录、项目、合成技能文件和本机 MCP HTTP 服务，不使用真实模型、API 密钥或用户的服务器配置。

验证原生 MCP 发现和初始化、主 Agent 工具调用、完整 JSON Schema 的透传、用户工具选择、错误结果、审批拒绝、停用与取消，以及技能发现和本轮上下文注入。

网络测试先比较生产会话与独立系统代理会话的解析结果，再仅在测试 Electron 进程内把同一 Chromium 代理解析器指向本地代理。使用无法直接解析的 `.invalid` 地址，验证 MCP 确实经过代理。不会更改操作系统代理；不覆盖第三方 stdio 服务内部的联网行为。

报告写入 `.build/ui-redesign/studio-mcp-runtime-report.json`。测试关闭其 Electron 和本机服务，保留临时测试目录便于诊断。
