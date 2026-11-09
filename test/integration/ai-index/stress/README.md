# 十万文件与高维向量压测

安装完整桌面依赖后运行：

```sh
npm run compile
npm run electron
npm run test:ai:index:stress
```

统一入口串行启动独立进程，避免不同样例的内存和 CPU 相互干扰。需要 macOS 桌面环境和数 GiB 临时磁盘空间；本机验证环境为 macOS arm64 / 16 GiB RAM。测试创建临时工作区和用户配置，结束后清理。不要同时编译或运行其他性能测试。所有向量由本地确定性 fixture 生成，不读取真实项目，不调用外部模型服务。

| 样例 | 覆盖范围 |
|---|---|
| `store-1536` | 100000 条独立、稠密 Float32 向量，1536 维，精确余弦检索 |
| `store-3072` | 同上，3072 维；每条向量拥有独立缓冲区，不共享数组或降维 |
| `native-3072` | Electron 原生 ABI 下从 SQLite 加载 100000 条 3072 维向量，检查重载峰值和关闭后的释放 |
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

Node 使用 `process.memoryUsage()` 和 `resourceUsage().maxRSS`；Electron 使用 CDP 的 heap/backing storage 和每 250 ms 采样的 `app.getAppMetrics()`，同时采纳操作系统提供的进程峰值。整体应用 RSS 求和可能重复计算共享页，主要比较单个渲染进程。心跳延迟报告包含测试控制和显式 GC，不能直接视为纯检索延迟。

结果保存在 `.build/ai-index-stress/report.json` 及各样例 JSON，包含实现源码 SHA-256、样本数、向量维度、内存、延迟、取消耗时和验收结果。该门槛用于固定本地样例回归，不代表公网 Embedding 吞吐量或检索相关性评测。

## CI

在 `AI Studio CI` 的手动运行参数中启用 `index_stress`，macOS desktop 任务会在常规索引测试后执行完整压测并上传 JSON。普通 push / pull request 保留常规回归，不自动生成十万文件。[托管三平台常规索引回归已通过](https://github.com/universeMmm/ai-studio/actions/runs/42574093326)（每平台 1000 文件、20 项检查）；这不代替十万文件压测。本轮十万文件 4 组仍为本机 macOS 结果，托管 `index_stress` 与 Windows/Linux 十万文件压测尚未执行。
