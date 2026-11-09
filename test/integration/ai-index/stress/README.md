# 十万文件与高维向量压测

安装完整桌面依赖后运行：

```sh
npm run compile
npm run electron
npm run test:ai:index:stress
```

统一入口支持 Windows、Linux、macOS，串行启动独立进程，避免不同样例的内存和 CPU 相互干扰。需要桌面环境和数 GiB 临时磁盘空间，建议至少 8 GiB RAM；无桌面的 Linux 使用 `xvfb-run -a npm run test:ai:index:stress`。原生依赖安装要求见[桌面回归说明](../README.md)。测试创建临时工作区和用户配置，结束后等待数据库关闭并清理；运行时保留测试打开的工作台窗口。不要同时编译或运行其他性能测试。所有向量由本地确定性 fixture 生成，不读取真实项目，不调用外部模型服务。

| 样例 | 覆盖范围 |
|---|---|
| `store-1536` | 100000 条独立、稠密 Float32 向量，1536 维，精确余弦检索 |
| `store-3072` | 同上，3072 维；每条向量拥有独立缓冲区，不共享数组或降维 |
| `native-3072` | Electron 原生 ABI 下从 SQLite 加载 100000 条 3072 维向量，检查加载中取消、重新加载全部条目、精确检索 P50/P95、查询取消、峰值与关闭后的释放 |
| `workspace-3072` | 100000 个真实长路径文件，清单超过旧的 10 MiB 上限；真实文件服务、ripgrep、IndexedDB、索引服务与混合检索，仅替换模型 Embedding 函数 |

文件清单使用最多 64 MiB 的独立输出预算，普通命令/关键词输出仍限制为 10 MiB；截断清单会报错，不会据此清理已存索引。

工作区样例先以 16 MiB 索引预算触发限额，再提高到 2048 MiB 完成全部十万文件，验证增量复用、查询取消、扫描取消、重载取消和取消后的恢复。1536/3072 维的纯向量数据分别约为 586/1172 MiB；完整索引的内存还包含文本、指纹、对象、工作台及临时缓冲区。

## 指标与验收门槛

- 精确检索：9 次请求（包含冷查询）记录 P50/P95，P95 小于 2000 ms，并检查自身向量的 top-1。
- 真实工作区混合检索：7 次请求，包含向量检索、模型 fixture 和 ripgrep，P95 小于 5000 ms。
- 查询取消：核心小于 150 ms、工作区小于 200 ms，均包含预定取消计时器的调度等待；扫描在第 100 ms 请求取消，总耗时小于 300 ms；重载取消完成小于 200 ms。
- RSS：核心进程峰值小于启动 RSS + 向量字节数 × 1.6 + 256 MiB；渲染进程峰值小于启动峰值 + 向量字节数 × 1.7 + 512 MiB。
- 释放：关闭后做受控 GC，核心/SQLite 的 external memory 和渲染进程 backing storage 与启动相比增加小于 32 MiB。RSS 可能由分配器保留，不把 RSS 立即回落当作向量引用已释放的必要条件。
- 预算：索引条目估算占用不超过设置值，达到预算后停止新增条目并报告状态；提高预算后补齐，未变更扫描和重载不新增 Embedding 请求。

Node / SQLite 使用 `process.memoryUsage()`、每 10 ms 的 RSS 采样和 `resourceUsage().maxRSS`；Electron 使用 CDP 的 heap/backing storage 和每 250 ms 采样的 `app.getAppMetrics()`，同时采纳操作系统提供的进程峰值。整体应用 RSS 求和可能重复计算共享页，主要比较单个渲染进程。心跳延迟报告包含测试控制和显式 GC，不能直接视为纯检索延迟。

结果保存在 `.build/ai-index-stress/report.json` 及各样例 JSON，包含实现源码 SHA-256、平台/架构、物理内存、CPU 数、Electron/Node/ABI、CI commit/run/attempt、样本数、向量维度、内存、延迟、取消耗时和验收结果。`node test/integration/ai-index/stress/ci-report.mjs` 检查四组报告与当前提交、运行及源码一致，并输出指标表；缺失、过期或失败的报告均不能通过。每个核心/原生样例最多 10 分钟，真实工作区最多 25 分钟；超时终止子进程树并保留已完成样例，工作区异常退出记录退出状态和最近的 Electron 错误输出。该门槛用于固定合成样例回归，不代表公网 Embedding 吞吐量或检索相关性评测。

## CI

在 `AI Studio CI` 的手动运行参数中启用 `index_stress`，三平台 desktop 任务会在常规索引测试后各执行完整四组压测并上传 JSON。Linux 通过 Xvfb 运行。推送到 `codex/index-stress-*` 验证分支（或其 PR）也会执行压测，因此工作流尚未合入默认分支时仍可验收。其他 push / pull request 保留常规回归。每个平台压测步骤最多 45 分钟，沿用相同的性能门槛；十万文件全量构建/重载的单阶段等待上限为 10 分钟，与取消及检索的毫秒级门槛分开。

报告随 `ai-desktop-report-<runner>` 上传，保留 7 天；Actions Job Summary 显示每组峰值、查询 P50/P95、查询取消和重载取消。依赖安装阶段为 ripgrep 的 GitHub Release API 请求提供任务自带的只读 `GITHUB_TOKEN`，避免共享出口未认证请求返回 403。常规 1000 文件回归与十万文件压测的验证结果分别记录在[开发计划](../../../../README.md#开发计划)。
