# AI 安全基线回归

使用临时工作区、临时配置和合成密钥，不连接真实模型服务，不读取用户的密钥。桌面测试会打开并自动关闭一个独立 AI Studio 窗口，请勿手动关闭。

```bash
npm run check:ai
npm run test:ai:security
npm run compile
npm run electron
npm run test:ai:security:desktop
```

`test:ai:security` 调用产品中的沙箱策略、主进程上下文创建和命令执行器，只有 IPC 传输替换为同进程桥接。它验证工作区写入、自动命令只读、越界写入拒绝、工作区外的私有目录读取拒绝、环境凭据剔除、网络拒绝、取消和临时目录回收，包含空格、单引号和 `$()` 路径。网络探针只访问本机临时 HTTP 服务。取消延迟从发出取消请求计时。

`test:ai:security:desktop` 通过真实工作台服务与 Electron IPC 执行命令，验证默认沙箱、外部命令审批、关闭沙箱后强制审批、隐藏旧设置、旧模型密钥不再自动填入，以及密钥保存失败时保留模型配置。测试使用独立的内存 SecretStorage，确认迁移不会删除唯一的持久化旧副本；持久化成功、读取校验、冲突和失败路径由 `credentialService.test.ts` 覆盖。

报告分别写入 `.build/ai-security/report.json` 和 `.build/ai-security/desktop-report.json`。`check:ai` 包含类型检查、依赖边界、密钥迁移、设置同步排除、路径替换、命令审批和无效沙箱配置的回归。

## 平台条件与边界

- macOS 使用系统 Seatbelt；Linux 需要可用的 `bubblewrap` 和 `socat`；Windows 使用随应用提供的 MXC。缺少依赖、配置不合法或启动失败时阻止执行，不自动降级为无沙箱命令。
- Linux 桌面测试需要图形会话或 Xvfb。Windows 的原生 MXC 权限与网络行为仍需在真实 runner 验证；配置单测不能代替原生验收。
- `ai.commandSandbox` 默认 `required`，网络默认阻断。用户显式改为 `off` 后每条命令均需批准；工作区设置不能放宽此策略。
- 默认按需审批只自动放行 `pwd` 和字面量 `echo`，给予只读工作区权限。Git、包管理器、解释器等外部程序需要批准；批准后的沙箱允许工作区及本次临时目录写入。子进程使用最小环境变量列表。
- 沙箱覆盖 `run_command`，不自动覆盖第三方 MCP 进程、模型 HTTP 请求和其他文件服务。获准执行的命令可以读取授权工作区内的内容；不要把整个人员主目录作为工作区授权。
- 文件工具固定本轮工作区根路径，在读取前后和写入前重新校验真实路径。它们仍不是基于原生句柄的原子文件操作，极短的替换/恢复竞态尚未完全消除。工作区外路径继续拒绝，不提供自动扩权。
- 本轮仅报告本机 macOS 实测结果；Windows/Linux 原生沙箱及托管验收仍是后续任务，既有索引 CI 的通过不等于安全沙箱验收通过。
