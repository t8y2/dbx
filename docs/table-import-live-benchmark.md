# CSV/Excel 批量导入真实环境性能基准

**测试日期：2026 年 7 月 29 日**

本基准测试对比父提交 `a96cf1194` 的实现与本 PR 优化后的导入路径。测试覆盖完整的文件解析和数据库写入流程，而不只是 SQL 生成过程。

## 测试环境

- 客户端：Windows 11 64 位，Intel Core i7-13620H（10 核、16 个逻辑处理器），31.7 GiB 内存。
- 工具链：Rust 1.96.0，使用 release profile，`dbx-core` 通过 `--no-default-features` 构建。
- SQL Server：SQL Server 2022 `16.0.4265.3`，运行于本地 Docker 容器。
- PostgreSQL：PostgreSQL `16.14`，远程可写测试实例；未隔离网络波动及服务器负载。
- MySQL：MySQL `8.4.6`，远程可写测试实例，`max_allowed_packet = 64 MiB`；未隔离网络波动及服务器负载。
- 导入表结构：1 个 `BIGINT` 列和 11 个文本列。SQL Server、PostgreSQL 使用 `batch_size = 500`；MySQL 使用 `batch_size = 10000`，确保单个解析批次生成的 SQL 超过 512 KiB 目标并进入按字节拆批路径。
- CSV 数据集：40,889,006 字节，200,000 行 × 12 列。
- Excel 数据集：4,559,480 字节（压缩后的 XLSX），100,000 行 × 12 列，共 120 万个单元格。

每个场景运行 3 次，基线版本和当前版本交替执行，结果表采用中位数。文件生成和数据库初始化不计入计时，文件解析和数据库写入计入计时。吞吐测试期间每 10 ms 采样一次进程 RSS。取消测试在首次收到写入进度后发出取消请求，取消延迟指从发出请求到导入 Future 返回所需的时间。

测量前已校验独立构建的可执行文件：

- 基线版本 SHA-256：`6E1C95139F3360EDBD0BBC5D739FEC5DBD628911C288BA339424271B088077D9`
- 优化版本 SHA-256：`51D79649B2475BF5A0B40549A6F04FC880344881149F9BF7E2157A157183BB5C`

MySQL 补测在合并上游后重新独立构建，使用以下可执行文件：

- MySQL 基线版本 SHA-256：`A884D76A1A39BED0198AB72872E1CE96DB678ABB97E04737000E7465D8865868`
- MySQL 优化版本 SHA-256：`48418182C662CEC4B198D4AD0CF6376164B857E05B102526B269CB553EE7E4F3`

## 测试结果

| 数据库 | 数据源 | 导入路径 | 文件大小（字节） | 行数 × 列数 | 耗时（ms） | 吞吐量（行/秒） | 峰值 RSS（MiB） | RSS 增量（MiB） | 取消延迟（ms） |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SQL Server | CSV | 生成 INSERT（`a96cf1194`） | 40,889,006 | 200,000 × 12 | 38,568.1 | 5,185.6 | 20.04 | 5.76 | 0.833 |
| SQL Server | CSV | TDS Bulk + NVARCHAR 暂存表 | 40,889,006 | 200,000 × 12 | 8,142.1 | 24,563.7 | 20.21 | 5.49 | 0.760 |
| SQL Server | XLSX | 生成 INSERT（`a96cf1194`） | 4,559,480 | 100,000 × 12 | 19,667.9 | 5,084.4 | 19.68 | 4.41 | 0.624 |
| SQL Server | XLSX | TDS Bulk + NVARCHAR 暂存表 | 4,559,480 | 100,000 × 12 | 5,271.6 | 18,969.5 | 19.62 | 4.56 | 0.482 |
| PostgreSQL | CSV | 每个解析批次执行一次 COPY（`a96cf1194`） | 40,889,006 | 200,000 × 12 | 36,243.0 | 5,518.3 | 23.03 | 5.70 | 1.536 |
| PostgreSQL | CSV | 8 MiB / 5 万行 COPY 累加器 | 40,889,006 | 200,000 × 12 | 4,967.9 | 40,258.7 | 37.82 | 20.29 | 1.202 |
| PostgreSQL | XLSX | 每个解析批次执行一次 COPY（`a96cf1194`） | 4,559,480 | 100,000 × 12 | 22,838.6 | 4,378.6 | 22.59 | 4.05 | 0.912 |
| PostgreSQL | XLSX | 8 MiB / 5 万行 COPY 累加器 | 4,559,480 | 100,000 × 12 | 4,160.7 | 24,034.2 | 37.09 | 18.93 | 0.855 |
| MySQL | CSV | 重复序列化并二分确定 512 KiB INSERT 批次（`a96cf1194`） | 40,889,006 | 200,000 × 12 | 33,786.3 | 5,919.6 | 100.33 | 84.79 | 13.659 |
| MySQL | CSV | 行值单次序列化 + SQL 字节自适应批次 | 40,889,006 | 200,000 × 12 | 18,793.6 | 10,641.9 | 93.55 | 79.20 | 12.746 |
| MySQL | XLSX | 重复序列化并二分确定 512 KiB INSERT 批次（`a96cf1194`） | 4,559,480 | 100,000 × 12 | 18,785.0 | 5,323.4 | 77.71 | 62.84 | 9.957 |
| MySQL | XLSX | 行值单次序列化 + SQL 字节自适应批次 | 4,559,480 | 100,000 × 12 | 11,210.4 | 8,920.3 | 71.69 | 56.43 | 9.489 |

吞吐量中位数变化如下：

- SQL Server CSV：提升至 `4.74x`（`+373.7%`）。
- SQL Server Excel：提升至 `3.73x`（`+273.1%`）。
- PostgreSQL CSV：提升至 `7.30x`（`+629.5%`）。
- PostgreSQL Excel：提升至 `5.49x`（`+448.9%`）。
- MySQL CSV：提升至 `1.80x`（`+79.8%`）。
- MySQL Excel：提升至 `1.68x`（`+67.6%`）。

PostgreSQL COPY 累加器以有界的内存开销换取更少的网络往返次数。在这些数据集上，其峰值 RSS 中位数增加约 14～15 MiB；内存使用仍受 COPY 累加器、编码后批次、解析器和驱动缓冲区共同约束。远程 PostgreSQL 的 CSV 测试存在网络波动，优化版本的吞吐量范围为 17,600～42,300 行/秒；表中报告的 40,258.7 行/秒是中位数，而非最好成绩。

MySQL 使用 10,000 行解析批次，使拆批前的候选 INSERT 约为 2 MiB，稳定超过 512 KiB SQL 目标。基线实现会反复序列化候选行并通过二分搜索确定拆分点；优化实现先将每行 SQL 值序列化一次，再按累计字节数线性拆批，因此本场景直接覆盖了被优化的路径。当前实现还会读取服务端 `max_allowed_packet` 并为单条 SQL 推导硬上限；本数据集没有触发 64 MiB 服务端包大小限制。大解析批次使 MySQL 两个版本的峰值 RSS 都明显高于 500 行场景，但优化版本的 CSV 和 XLSX 峰值 RSS 中位数分别降低 6.77 MiB 和 6.02 MiB。全部 MySQL 测试结束后再次查询测试 schema，`dbx_import_bench_%` 遗留表数量为 0。

## 边界场景补测

针对 SQL Server Bulk 转换内存评审，额外使用接近 TDS Bulk 单列编码上限的宽文本和最大有效批次运行 3 次。数据集为 180,034,911 字节 CSV、6,000 行 x 2 列，每个文本值 30,000 字节。命令请求 `batch_size = 5000`，但 SQL Server 导入会将其限制为 1,000 行，因此每个实际解析批次包含约 28.6 MiB 原始文本。结果仍取中位数：

| 场景 | 耗时（ms） | 吞吐（行/秒） | 峰值 RSS（MiB） | RSS 增量（MiB） | 取消延迟（ms） |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQL Server 宽字段大批次 | 5,663.7 | 1,059.4 | 132.30 | 117.91 | 20.866 |

该场景覆盖 SQL Server 允许的最大有效批次。解析线程、两槽有界通道和数据库消费者可能同时持有多个原始数据批次，因此进程 RSS 包含这些有界的源数据；Bulk 转换本身使用逐行转换和逐行 TDS 发送，不再创建批次级完整字符串矩阵，转换后的附加内存受 16 MiB 单行预算约束。单元回归同时覆盖 32 行 x 每行 1 MiB 的惰性转换，以及单行超过 16 MiB 预算时在复制前拒绝。Tiberius 当前会拒绝 UTF-16 编码长度超过 65,535 字节的单个 Bulk 字符串，因此真实写入补测使用 30,000 字节 ASCII 文本；1 MiB 单列输入会在驱动编码层被拒绝，不能作为成功写入基准。

针对 XLSX 首次写入前取消，回归夹具包含 8,193 个共享字符串，`sharedStrings.xml` 正文约 4.16 MiB。3 次取消计时为 162.64 ms、139.22 ms 和 153.67 ms，中位数为 153.67 ms；取消均发生在 Header 和任何数据库写入之前。读取器每 64 KiB 检查共享取消状态，异步侧每 25 ms 轮询一次，预校验和正式解析分别占文件读取进度的前、后 50%，进度保持单调。

宽字段场景可使用以下附加参数复现：

```powershell
cargo run -p dbx-core --no-default-features --release `
  --example table_import_live_bench -- `
  --database=sqlserver --format=csv --rows=6000 --columns=2 `
  --batch-size=5000 --text-bytes=30000
```

## 复现方式

数据库连接信息仅通过环境变量提供：

```powershell
$env:DBX_BENCH_HOST = '<host>'
$env:DBX_BENCH_PORT = '<port>'
$env:DBX_BENCH_USER = '<user>'
$env:DBX_BENCH_PASSWORD = '<password>'
$env:DBX_BENCH_DATABASE = '<database>'
$env:DBX_BENCH_SCHEMA = '<schema>'

cargo run -p dbx-core --no-default-features --release `
  --example table_import_live_bench -- `
  --database=postgres --format=csv --rows=200000 --columns=12 --batch-size=500
```

测试 MySQL 或 SQL Server 时分别使用 `--database=mysql` 或 `--database=sqlserver`；MySQL 性能补测同时使用 `--batch-size=10000`。测试 Excel 场景时使用 `--format=xlsx --rows=100000`。基准程序会创建名称唯一的临时表，依次执行吞吐测试和取消测试，输出一条 JSON 结果，并在结束时删除测试表和临时文件。
