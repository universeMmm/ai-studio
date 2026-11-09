# 工作区增量索引桌面回归

Windows、Linux、macOS 共用同一个入口，直接启动开发版 Electron。先安装完整桌面依赖并编译，再执行：

```sh
npm run compile
npm run electron
npm run test:ai:index
```

测试使用 Playwright 启动真实 Electron 工作台、临时用户配置和 1000 文件的临时工作区，只连接本机 HTTP Embedding fixture，使用合成密钥和两维向量。退出后清理临时文件，不需要真实模型账号。不能与 `npm run compile` 同时执行，因为编译会重新生成工作台文件。

20 项检查覆盖：

- 真实工作台：关闭时零请求、跨文件批量构建、未变更扫描零请求、监听修改及新增/重命名/目录删除、IndexedDB 重启复用、取消实际 HTTP 请求、恢复、开关与变更补偿、文件数上限。
- 路径差异：工作区及文件名包含中文/空格、精确 include 规则的关键词回退、仅大小写变化的重命名。
- 原生模块：Electron ABI 下直接加载 SQLite 和 Parcel watcher 并实际读写/监听，执行内置 ripgrep。模块加载失败会失败，不能以纯内存回退通过。
- 资源与取消：512 个 3072 维 SQLite 条目的持久化/重载/取消/恢复、等待关闭后立即删除数据库目录、取消长命令及其后代进程、命令超时、调用者取消混合检索。

常规 CI 的取消门槛考虑托管机器调度抖动：HTTP 请求断开 < 1500 ms，查询/SQLite 重载取消 < 1000 ms，子进程树停止和 100 ms 命令超时总响应 < 2000 ms；报告记录实测值。十万文件压力测试继续使用更严格的性能门槛。

Linux 需要原生构建依赖和可用的显示服务；无桌面环境时使用 `xvfb-run -a npm run test:ai:index`。Windows 需要 Visual Studio 2022 C++/Spectre 工具链。原生模块必须使用本仓库 `.npmrc` 的 Electron target 编译，不要复用另一平台或普通 Node ABI 的 `node_modules`。CI 的系统依赖依据 [VS Code 贡献指南](https://github.com/microsoft/vscode/wiki/How-to-Contribute) 和 [Windows runner 镜像清单](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)。

报告写入 `.build/ui-redesign/studio-index-runtime-report.json`，记录平台、架构、Electron/Node/模块 ABI、CI commit/run ID、检查结果和耗时。GitHub Actions 为 Ubuntu 22.04、macOS 15、Windows 2022 分别执行完整安装、编译、Electron 准备及该测试，报告分别上传为 `ai-desktop-report-<runner>`。2026-11-09 提交 `8a45038` 的[托管 CI 六项任务全部通过](https://github.com/universeMmm/ai-studio/actions/runs/42574093326)：三平台各 20 项索引检查通过，报告中的提交号、平台和 ABI 已逐份核对；macOS 另通过 10 项技能/MCP 检查。本机存档为 `.build/ai-index-ci/42574093326/`。

索引专项使用 `npm run test:ai:index:unit`（当前 30 项，Windows core 任务执行此套件）；完整 AI 回归使用 `npm run check:ai`（当前 297 项，Ubuntu/macOS core 任务执行），包括类型检查和索引服务测试：事件合并、多根工作区、mtime/hash 跳过、取消/恢复、排除规则、请求限速、错误重试、响应顺序和 IPC 取消。

十万真实文件、1536/3072 维向量的内存、检索与取消压测使用 `npm run test:ai:index:stress`。方法、门槛和按需 CI 参数见 [压力测试说明](stress/README.md)。
