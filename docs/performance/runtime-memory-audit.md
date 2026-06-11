# DBX Web 运行内存功能排查报告

日期：2026-06-11

## 结论

已将网页版 DBX 的访问密码设置为 `test`，并通过接口验证登录成功。当前可访问地址：

```text
http://127.0.0.1:5173/login
```

本次用独立 Chrome profile 打开 DBX Web，创建 5 万行 SQLite 测试库，逐项触发主要功能并采集运行内存。当前测到最占运行内存的功能是：

1. 数据对比 Data Compare：优化前后端 `dbx-web` RSS 从约 213 MiB 峰值升到约 496 MiB，是原始基线中最高。
2. 查询图表 QueryChart：在 5 万行结果上打开图表后，前端 JS heap 升到约 109 MiB，Chrome renderer 峰值约 567 MiB。
3. 查询结果 DataGrid：5 万行、12 列查询结果进入 DataGrid 后，前端 JS heap 约 78 MiB，Chrome renderer 约 480 MiB，后端 RSS 约 194 MiB。
4. 驱动管理 Driver Store：DOM 节点明显增加，但 JS heap 被 GC 后下降，未表现为主要内存来源。
5. 空数据对比对话框：只打开对话框增量很小，不是内存大头；真正占用来自执行对比。

第一轮已优化 Data Compare 后端内存路径：同样 50,000 vs 49,649 行场景下，`dbx-web` RSS 峰值从 507,504 KiB 降到 239,696 KiB，下降约 53%；接口输出计数、SQL 数量和响应大小保持一致。

开发服务器 Vite 本身 RSS 很高，后续一度到约 1.1-1.2 GiB。这是 dev/HMR 工具链占用，不属于某个业务功能，但会显著抬高当前机器的总内存占用。

## 密码重置

认证实现：

- 前端登录接口：`/api/auth/login`
- 初始设置接口：`/api/auth/setup`
- 后端密码存储：`~/.dbx-web/dbx.db` 的 `app_settings.settings_json.password_hash`
- `DBX_PASSWORD` 环境变量会覆盖数据库密码，但本次没有用环境变量覆盖，而是走 `/api/auth/setup` 持久化设置。

验证结果：

```text
POST /api/auth/setup {"password":"test"} -> 200 OK
POST /api/auth/login {"password":"test"} -> 200 OK
GET /api/auth/check with cookie -> {"authenticated":true,"required":true,"setup_required":false}
```

## 测试环境

运行进程：

| 组件 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| Web 前端 | `http://127.0.0.1:5173` | 已存在的 Vite dev server |
| Web 后端 | `target/debug/dbx-web`，端口 `4224` | 本次启动，用于 API 和认证 |
| 测量浏览器 | Chrome 独立 profile：`/tmp/dbx-runtime-chrome-profile` | 只打开 DBX 页面，避免混入日常 Chrome tab |

测试数据：

| 对象 | 规模 |
| --- | ---: |
| SQLite 文件 | `/tmp/dbx-runtime-memory-probe.sqlite` |
| DBX 连接名 | `Runtime Memory SQLite` |
| `runtime_probe` | 50,000 行，12 列 |
| `runtime_probe_target` | 49,649 行，12 列 |
| DataGrid page size | 50,000 |
| DataGrid render mode | Canvas |

## 测量方法

采集方式：

- Chrome DevTools Protocol `Performance.getMetrics`
  - `JSHeapUsedSize`
  - `JSHeapTotalSize`
  - DOM node count
- macOS `ps`
  - 独立 Chrome profile 总 RSS
  - Chrome renderer RSS
  - Vite RSS
  - `dbx-web` RSS
- 数据对比 API 额外用 50ms 间隔采样 `dbx-web` RSS 峰值。

注意：

- JS heap 是前端页面 heap，不包含浏览器共享库、GPU、网络进程等。
- Chrome renderer RSS 更接近页面实际进程内存，但仍包含渲染器基础开销。
- Vite 是开发工具链，不应归因到业务功能。
- 数据对比 API 测到的是后端执行峰值；本轮没有自动填完整数据对比对话框并渲染 diff 明细。

## 运行内存记录

单位说明：

- JS heap：MiB
- RSS：KiB，括号内为约 MiB

| 场景 | JS heap used | Chrome renderer RSS | Chrome profile 总 RSS | `dbx-web` RSS | Vite RSS | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 登录页 | 13.30 MiB | 未拆分 | 906,576 KiB（885 MiB） | 未启动/低 | 475,200 KiB（464 MiB） | 登录页 DOM 约 255 |
| 登录后主界面 | 25.12 MiB | 未拆分 | 961,760 KiB（939 MiB） | 72,688 KiB（71 MiB） | 481,376 KiB（470 MiB） | 已加载连接列表 |
| 打开查询编辑器 | 25.86 MiB | 未拆分 | 未记录 | 未记录 | 未记录 | CodeMirror 出现，增量很小 |
| 设置 page size 后刷新 | 31.83 MiB | 408,608 KiB（399 MiB） | 1,003,440 KiB（980 MiB） | 54,048 KiB（53 MiB） | 1,224,272 KiB（1,196 MiB） | Dev server RSS 明显上升 |
| 填入 SQL | 34.94 MiB | 414,144 KiB（404 MiB） | 1,016,384 KiB（993 MiB） | 54,720 KiB（53 MiB） | 1,224,272 KiB（1,196 MiB） | 编辑器文本变化 |
| DataGrid 5 万行结果 | 77.98 MiB | 491,440 KiB（480 MiB） | 1,089,552 KiB（1,064 MiB） | 198,448 KiB（194 MiB） | 1,249,856 KiB（1,221 MiB） | 50,000 行、12 列、Canvas |
| 图表前，GC 后 | 61.15 MiB | 443,040 KiB（433 MiB） | 1,046,128 KiB（1,022 MiB） | 198,448 KiB（194 MiB） | 1,161,296 KiB（1,134 MiB） | DataGrid 结果仍在 |
| QueryChart 5 秒 | 109.77 MiB | 580,976 KiB（567 MiB） | 1,185,408 KiB（1,158 MiB） | 198,448 KiB（194 MiB） | 1,172,096 KiB（1,145 MiB） | ECharts + series 数据峰值 |
| QueryChart 10 秒 | 108.74 MiB | 524,160 KiB（512 MiB） | 1,128,544 KiB（1,102 MiB） | 198,448 KiB（194 MiB） | 1,172,096 KiB（1,145 MiB） | 图表稳定后 |
| 空数据对比对话框 | 110.72 MiB | 531,520 KiB（519 MiB） | 1,141,376 KiB（1,115 MiB） | 198,448 KiB（194 MiB） | 1,187,120 KiB（1,159 MiB） | 只打开弹窗，增量小 |
| Data Compare API | 不适用 | 不适用 | 不适用 | 峰值 507,504 KiB（496 MiB） | 不适用 | 50k vs 49,649 行，两表对比 |
| 驱动管理 | 67.49 MiB | 535,072 KiB（522 MiB） | 1,145,696 KiB（1,119 MiB） | 478,928 KiB（468 MiB） | 1,188,624 KiB（1,161 MiB） | DOM 到 1,157，但 JS heap 被 GC |

## 数据对比明细

### 优化前基线

接口：

```text
POST /api/data-compare/prepare-from-tables
```

参数：

```text
source table: main.runtime_probe
target table: main.runtime_probe_target
key columns: id
fetch batch size: 5000
```

结果：

| 指标 | 值 |
| --- | ---: |
| 耗时 | 842 ms |
| `dbx-web` RSS before | 217,904 KiB（213 MiB） |
| `dbx-web` RSS peak | 507,504 KiB（496 MiB） |
| `dbx-web` RSS after | 472,416 KiB（461 MiB） |
| 响应大小 | 10,291,638 bytes |
| source rows | 50,000 |
| target rows | 49,649 |
| added | 1,351 |
| removed | 1,000 |
| modified | 4,865 |
| sync statements | 7,216 |
| sync SQL 大小 | 1,537,738 bytes |

判断：数据对比是本轮最高内存来源。原因是后端会同时持有两边 rows、HashMap、diff、sync statements 和完整 sync SQL；请求结束后 RSS 也没有立刻回到对比前。

### 第一轮优化复测

代码改动：

- `crates/dbx-core/src/data_compare.rs`
- 对比中间态从“每一行都转成 `HashMap<String, Value>`”改为“按列索引保存 `Vec<Value>`，只在 added/removed/modified 输出时组装 HashMap”。
- 去掉 `prepare_data_compare` 和缺目标表路径里的 `DataCompareResult` clone。
- 单元格比较改为借用比较，只有确认为变化时才 clone 到返回结果。
- 同步计划生成改为内部借用 diff，公共 API 和返回字段不变。

复测结果：

| 指标 | 优化前 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 耗时 | 842 ms | 942 ms | +100 ms |
| `dbx-web` RSS before | 217,904 KiB（213 MiB） | 65,168 KiB（64 MiB） | 启动基线更干净 |
| `dbx-web` RSS peak | 507,504 KiB（496 MiB） | 239,696 KiB（234 MiB） | -267,808 KiB（约 -53%） |
| `dbx-web` RSS after | 472,416 KiB（461 MiB） | 233,840 KiB（228 MiB） | -238,576 KiB |
| 响应大小 | 10,291,638 bytes | 10,291,638 bytes | 不变 |
| added / removed / modified | 1,351 / 1,000 / 4,865 | 1,351 / 1,000 / 4,865 | 不变 |
| sync statements | 7,216 | 7,216 | 不变 |
| sync SQL 大小 | 1,537,738 bytes | 1,537,738 bytes | 不变 |

结论：这次优化不改变接口协议和功能结果，主要降低后端比较过程的峰值和结束后的 RSS 留存。剩余内存主要来自必须返回给前端的 diff 详情、`syncStatements` 数组、完整 `syncSql` 字符串以及约 10 MB JSON 响应。

## 功能排名

### 1. 数据对比 Data Compare

原始基线最高。50k 级别两表对比让后端 RSS 峰值接近 496 MiB，且结束后仍约 461 MiB。第一轮优化后，同场景峰值降到约 234 MiB，结束后约 228 MiB。

主要来源：

- 源表 rows + 目标表 rows
- diff 明细对象
- sync statements
- joined sync SQL
- 约 10 MB JSON 响应

建议：

- 进一步对比可改为主键有序 merge，不一次性保留两边全量 rows。
- diff 明细分页，默认只返回计数和样例。
- sync SQL 按需生成或流式下载。
- 大表对比增加行数阈值和用户确认。

### 2. QueryChart

本轮最高的前端内存增量。基于同一份 5 万行查询结果，打开图表后 JS heap 稳定在约 109 MiB，较图表前增加约 48 MiB；renderer RSS 峰值增加约 138 MiB。

主要来源：

- ECharts / vue-echarts 运行时
- `xData = rows.map(...)`
- 每个 Y 列再生成一份 series data
- Canvas 图表内部缓存

建议：

- 图表默认采样或限制最大点数，例如 5,000。
- 多 Y 轴列时显示数据点数量并要求确认。
- 数值列识别用抽样，不扫描全部 rows。

### 3. 查询结果 DataGrid

5 万行、12 列进入 DataGrid 后，JS heap 约 78 MiB，较填 SQL 后增加约 43 MiB；后端 RSS 也从约 53 MiB 增至约 194 MiB。

主要来源：

- 查询结果 rows
- DataGrid 显示索引和派生结构
- Canvas 渲染状态
- 后端查询结果构造和 JSON 序列化

建议：

- 默认 page size 不要轻易升到 50,000。
- DataGrid 派生数组按可视范围懒生成。
- 导出和大结果操作走 streaming。
- 对大结果显示明确内存提示。

### 4. 驱动管理

驱动管理页面 DOM 节点从 426 增到 1,157，但 JS heap 因 GC 从约 112 MiB 降到约 67 MiB，说明它不是当前主要内存来源。它主要增加 DOM 和列表渲染，不像 DataGrid/Chart/DataCompare 那样复制大数据。

### 5. 空数据对比对话框

只打开对话框时 JS heap 从约 109 MiB 到约 111 MiB，增量很小。风险不在弹窗本身，而在点击“开始比较数据”后的后端对比和 diff 明细。

## 未覆盖功能

本轮没有实测以下功能，因为当前环境没有对应服务或没有构造完整数据流：

- Redis Key Browser
- Mongo 文档浏览
- 数据传输
- SQL 文件执行
- 导出下载全流程
- ER Diagram / Schema Diff 大 schema 场景
- AI Assistant 长对话

这些功能仍可能在真实环境中占用较高内存，尤其是 Redis 全量 key、Mongo 宽文档表格视图、导出聚合和大 schema diff。代码风险分析见同目录的 `memory-usage-audit.md`。

## 当前最值得优化的点

1. 继续优化 Data Compare 返回体：第一轮已降峰值，下一步是 diff 分页、SQL 按需生成，减少必须返回给前端的数据量。
2. 限制 QueryChart 数据点：图表对大结果集的前端复制非常明显。
3. 限制 DataGrid 大 page size：50,000 行能明显抬高前端和后端内存。
4. 把 Vite/dev 内存与业务内存分开看：当前开发模式下 Vite RSS 本身可超过 1 GiB，生产 Tauri 或生产 Web 包需要另测。
