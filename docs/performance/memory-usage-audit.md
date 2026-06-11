# DBX 内存占用功能排查报告

日期：2026-06-11

## 结论摘要

本次排查结合了当前运行进程快照、前端 bundle 体积、以及主要功能的代码路径。当前进程里最大的 repo 相关内存占用是开发服务器 `vite`，RSS 约 442 MiB；这属于开发工具链占用，不应直接归因到 DBX 某个业务功能。

业务功能层面，最容易导致内存占用率升高的是这些路径：

1. 查询结果 / 表数据 DataGrid / 导出：高风险，结果集会在原始 rows、筛选索引、显示项、搜索命中、导出 rows、磁盘缓存转换中多份存在。
2. 数据对比 Data Compare：高风险，后端一次性持有源表和目标表全量数据，并构建 HashMap、diff、同步 SQL；前端也会保留完整 diff 和 sync plan。
3. Redis Key Browser：高风险，`fetch all` 和 value search 可能扫描并保留大量 key，同时维护 flat list、tree list、visible rows 和命令历史。
4. Mongo 文档表格视图：中高风险，`documents` 会转换成 DataGrid 的二维 rows，嵌套对象还会被 `JSON.stringify`，随后再进入 DataGrid 的派生结构。
5. 查询图表 QueryChart：中高风险，打开图表会加载 ECharts，并把查询结果再次映射为 x/y series 数组。
6. Schema / Object Browser / ER Diagram：中风险，连接树、补全缓存、schema 关系和图节点会随库规模增长。
7. QueryEditor 补全、AI Assistant：中低风险，通常不是首要来源，但长会话、多 tab、频繁补全或长聊天会持续积累状态。

## 当前进程快照

命令：

```bash
ps -axo pid,ppid,rss,vsz,comm,args | awk 'NR==1 || /dbx|vite|pnpm|tauri|WebKit|node_repl|electron|cargo/ {print}' | sort -k3 -nr | head -40
```

主要观察：

| 进程 | RSS | 说明 |
| --- | ---: | --- |
| `node ... vite --config apps/desktop/vite.config.ts --port 5173 --mode web` | 452,880 KB，约 442 MiB | 当前最大 repo 相关进程，属于开发服务器和 HMR，占用通常高于生产包 |
| `com.apple.WebKit.WebContent` | 197,232 KB，约 193 MiB | WebKit 渲染进程，可能来自 Codex 内嵌浏览器或本地预览，需结合具体窗口确认 |
| `com.apple.WebKit.WebContent` | 165,872 KB，约 162 MiB | 同上 |
| `com.apple.WebKit.WebContent` | 130,672 KB，约 128 MiB | 同上 |
| `pnpm dev:web` | 52,352 KB，约 51 MiB | Vite 父进程 |

补充：`target`、`node_modules` 等目录体积是磁盘占用，不是运行时内存。当前 `target` 目录约 27 GiB，`node_modules` 约 543 MiB，主要影响磁盘空间和构建缓存，不直接解释内存占用率。

## 前端 Chunk 观察

当前 `dist/assets` 中较大的 JS chunk：

| Chunk | 大小 | 相关功能 |
| --- | ---: | --- |
| `index-C0boAXCG.js` | 600 KB | 主应用入口 |
| `QueryChart-DxFWVk_s.js` | 548 KB | 查询图表，包含 ECharts 相关逻辑 |
| `codemirror-Dy52TtRW.js` | 464 KB | SQL 编辑器 |
| `sql-formatter-BTQ26GQc.js` | 288 KB | SQL 格式化 |
| `DataGrid-kZSBZBlT.js` | 148 KB | 查询结果表格 |
| `RedisKeyBrowser-CdulxmUR.js` | 60 KB | Redis key 浏览器 |
| `AiAssistant-BrEVPSc_.js` | 52 KB | AI 助手 |

Chunk 体积不等于运行时内存，但能提示哪些功能首次打开会引入较重依赖。这里 `QueryChart` 的包体明显偏大，且运行时还会复制查询数据到 ECharts option。

## 功能排名与占用来源

| 排名 | 功能 | 风险 | 主要占用来源 | 典型触发 |
| ---: | --- | --- | --- | --- |
| 1 | 查询结果 / 表数据 / DataGrid / 导出 | 高 | 查询 rows、inactive tab 缓存、DataGrid 派生数组、搜索命中、导出 rows、缓存序列化峰值 | 大查询结果、多结果 tab、客户端搜索、全量导出 |
| 2 | 数据对比 Data Compare | 高 | 源表 rows、目标表 rows、HashMap、diff clone、sync statements、sync SQL、前端 selectable diff | 大表对比、批量表对比、差异很多 |
| 3 | Redis Key Browser | 高 | flat key list、tree key list、visible rows、checked set、命令历史 | `fetch all`、value search、大 keyspace |
| 4 | Mongo 文档表格视图 | 中高 | 原始 documents、转换后的 grid rows、对象 JSON 字符串、DataGrid 派生数组 | 大 page size、宽文档、嵌套对象多 |
| 5 | 查询图表 QueryChart | 中高 | ECharts 依赖、xData、series data、pie data | 大结果集打开图表、多 Y 轴列 |
| 6 | Schema / Object Browser / ER Diagram | 中 | treeNodes、schema cache、completion cache、diagram tables / relationships | 多库多 schema、超大表结构 |
| 7 | QueryEditor 补全和诊断 | 中 | CodeMirror、per-editor table/column/FK cache、语义诊断状态 | 多编辑器 tab、频繁触发补全 |
| 8 | AI Assistant | 中低 | conversations、messages、Markdown/Shiki 高亮缓存 | 很长对话、代码块多 |
| 9 | 连接池 / Agent / JDBC / SSH | 中低到中 | 后端连接、外部 driver/session、后台状态 | 打开很多连接或长时间不关闭 |

## 1. 查询结果 / DataGrid / 导出

这是最需要优先处理的业务路径。

代码证据：

- `apps/desktop/src/stores/queryStore.ts:136` 将 inactive 结果内存缓存上限设为 `MAX_CACHED_RESULTS = 5`。实际效果是当前 active tab 加最多 5 个 inactive tab 的结果仍可留在内存。
- `apps/desktop/src/stores/queryStore.ts:1406` 到 `1410` 只按 tab 数量淘汰 inactive 结果，没有按行数、列数或估算字节数淘汰。
- `apps/desktop/src/components/grid/DataGrid.vue:518` 到 `530` 即使没有本地列筛选，也会为所有 rows 构造一份索引数组。
- `apps/desktop/src/components/grid/DataGrid.vue:2350` 到 `2374` 会为显示行构造 `displayRowRefs`，`2404` 又映射成 `displayItems`。虚拟滚动减少 DOM 节点，但没有避免 JS 内存里存在全量派生数组。
- `apps/desktop/src/components/grid/DataGrid.vue:2445` 到 `2467` 客户端搜索会扫描所有显示行和列，并保存每个命中的坐标。
- `apps/desktop/src/stores/queryStore.ts:1469` 到 `1592` 导出时循环分页并 `rows.push(...result.rows)`，最终返回一个包含全量 rows 的 `QueryResult`。这会让导出期间出现明显内存峰值。
- `apps/desktop/src/lib/tabResultCache.ts:129` 到 `146` 在结果被转成列式 MessagePack 缓存时，会从 row-major rows 生成 column-major `columnValues`，恢复时又重建 rows。淘汰/恢复期间可能出现原始 rows、列式副本、编码 bytes 多份共存。

建议：

1. 将结果缓存从“最多 5 个 inactive tab”改为“按估算字节数 + tab 数”双上限，例如默认只保留当前 tab + 最近 1 到 2 个小结果；大结果立即落盘或只保留当前页。
2. DataGrid 内部避免为全量 rows 同时维护 `localFilteredRows`、`displayRowRefs`、`displayItems`。可改为基于索引的懒计算，虚拟滚动只生成可视范围 item。
3. 客户端搜索增加上限和渐进式扫描，例如只扫描当前页或前 N 行，超限提示用户改用 SQL 查询。
4. 导出改成 streaming writer，不返回包含全量 rows 的 `QueryResult`。CSV/Excel/JSON 都应边拉边写，避免 `rows.push(...)` 聚合。
5. 缓存落盘时避免 `structuredClone`、row-to-column、encode 同时叠加；可用分块序列化，或在清空原始引用后再进行后台转换。
6. 对 `MAX_RESULT_PAGE_SIZE` 做产品级收紧。当前最大可到 100,000 行，配合宽表和 DataGrid 派生数组会非常容易冲高内存。

## 2. 数据对比 Data Compare

这是第二个最高风险路径，而且会同时占用 Rust 后端和前端内存。

代码证据：

- `crates/dbx-core/src/data_compare.rs:227` 到 `250` 通过 `tokio::try_join!` 同时拉取源表和目标表 rows。
- `crates/dbx-core/src/data_compare.rs:723` 到 `768` 虽然按 batch 查询，但最终 `rows.extend(result.rows)` 聚合到一个 `Vec<Vec<Value>>` 后返回。
- `crates/dbx-core/src/data_compare.rs:422` 到 `489` 会把两边 rows 转为 compare rows，再收集到 HashMap/order，并 clone added / removed / modified 的 values。
- `crates/dbx-core/src/data_compare.rs:376` 到 `400` 会生成 `sync_statements`，再 join 成完整 `sync_sql`，SQL 文本本身也可能很大。
- `apps/desktop/src/components/diff/DataCompareDialog.vue:413` 到 `418` 会把 diff row 映射成 selectable diff。
- `apps/desktop/src/components/diff/DataCompareDialog.vue:500` 到 `528` 会把选中的 diff 发送给后端重建 sync plan。
- `apps/desktop/src/components/diff/DataCompareDialog.vue:538` 到 `692` 批量表对比会逐表 push 结果，最后 `batchResults.value = results`，完整 diff 留在前端状态里。

建议：

1. 对单表对比加硬上限，例如行数超过阈值时要求用户确认，或默认只对比 key/hash 摘要。
2. 改为按主键有序流式对比，避免源表和目标表全量同时驻留内存。
3. diff 明细分页加载，只在概览里保留计数和少量样例。
4. sync SQL 按需生成或流式下载，不在内存里长期保存完整 `sync_sql`。
5. 批量对比时完成一张表就释放中间 rows，只保留摘要；用户展开表时再加载明细。

## 3. Redis Key Browser

Redis 浏览器在大 keyspace 下容易膨胀。

代码证据：

- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:61` 到 `82` 同时持有 `flatKeys`、`treeKeys`、`checkedKeys`、`commandHistory` 等状态。
- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:141` 到 `146` 会从 tree 计算 `visibleRows`。
- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:154` 到 `177` 会基于 `flatKeys` 重建或合并 tree。
- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:222` 到 `227` value search 会持续 scan，直到没有更多结果。
- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:285` 到 `299` `fetchAll` 会循环 scan，直到所有 key 加载完。
- `apps/desktop/src/components/redis/RedisKeyBrowser.vue:387` 到 `389` 命令历史追加后没有长度上限。

建议：

1. `fetch all` 加数量上限、内存提示和二次确认；默认不应全量加载百万级 key。
2. value search 改成最多加载 N 条，然后提示继续加载。
3. `commandHistory` 做 ring buffer，例如最多保留 200 条。
4. tree 结构尽量使用紧凑节点，避免同时保留 flat、tree、visible 三份完整数据。

## 4. Mongo 文档表格视图

Mongo 单页默认受 page size 控制，但表格模式会复制数据。

代码证据：

- `apps/desktop/src/components/mongo/MongoDocBrowser.vue:35` 保存原始 `documents`。
- `apps/desktop/src/components/mongo/MongoDocBrowser.vue:122` 到 `154` 将 documents 转成 DataGrid `QueryResult`，为所有文档推导 columns 并生成二维 rows。
- `apps/desktop/src/components/mongo/MongoDocBrowser.vue:143` 到 `149` 对对象字段执行 `JSON.stringify`，宽文档或深嵌套对象会扩大字符串内存。
- `apps/desktop/src/components/mongo/MongoDocBrowser.vue:332` 到 `340` 每次加载 page 后替换 documents。

建议：

1. 表格视图只展开顶层标量字段；对象字段延迟 stringify，用户展开单元格时再格式化。
2. Mongo 表格模式使用更小的默认 page size。
3. 对宽文档增加列数或单元格字符串长度限制。

## 5. 查询图表 QueryChart

QueryChart 的包体和运行时复制都偏重。

代码证据：

- `apps/desktop/src/components/chart/QueryChart.vue:4` 到 `15` 引入并注册 ECharts CanvasRenderer、Line、Bar、Pie、Grid、Tooltip、Legend。
- `apps/desktop/src/components/chart/QueryChart.vue:29` `numericColumns` 会扫描 rows 判断数值列。
- `apps/desktop/src/components/chart/QueryChart.vue:57` 生成全量 `xData`。
- `apps/desktop/src/components/chart/QueryChart.vue:69` 到 `72` pie chart 为每一行生成 `{ name, value }`。
- `apps/desktop/src/components/chart/QueryChart.vue:96` 到 `100` 每个 Y 列都会再 map 一份 series data。

建议：

1. 图表默认只取前 N 行或采样，例如 5,000 行以内。
2. 多 Y 列时提示 series 数据量，超限则要求用户确认。
3. `numericColumns` 可以基于抽样判断，不需要扫描所有 rows。

## 6. Schema / Object Browser / ER Diagram

这类功能一般不会像大结果集那样瞬间冲高，但在多连接、多库、多 schema 长会话里会累积。

代码证据：

- `apps/desktop/src/stores/connectionStore.ts` 中维护 `treeNodes`、`loadedTreeNodeChildrenIds`、`completionTablesCache`、`completionObjectsCache`、`completionColumnsCache`、`schemaListCache` 等长期状态。
- 全局 completion cache 有 `COMPLETION_CACHE_MAX = 50`，但 schema tree 和已展开节点会随用户浏览而保留。
- `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue` 会持有 diagram tables、positions、relationships、visible map，超大 schema 下会增长明显。

建议：

1. 对 schema tree 增加“清理连接缓存”入口。
2. 大 schema 的 ER 图只加载用户选择的表及一跳关系。
3. completion cache 继续保留上限，但 per-connection/schema tree 也应考虑 LRU 或手动释放。

## 7. QueryEditor 补全与 AI Assistant

这两块不是当前首要嫌疑，但长时间使用会有累积。

代码证据：

- `apps/desktop/src/components/editor/QueryEditor.vue` 每个编辑器实例维护 `cachedTables`、`cachedCompletionObjects`、`cachedColumnsByTable`、`cachedForeignKeysByTable`。
- CodeMirror、language packages、SQL formatter 是较大的编辑器相关依赖。
- `apps/desktop/src/components/editor/AiAssistant.vue` 维护 messages、conversations、mention cache，并使用 Markdown / Shiki 代码高亮。

建议：

1. 编辑器 per-tab cache 增加容量或生命周期限制，tab 关闭时确认释放。
2. AI conversations 只在当前会话保留最近 N 条渲染消息，旧消息可折叠或按需加载。
3. 代码高亮按可见消息懒加载，避免一次性渲染长历史。

## 优先优化清单

短期优先做：

1. 把查询结果缓存从 tab 数上限改成内存估算上限，先降低 inactive result 的保留数量。
2. 导出改为 streaming，避免在 `fetchTabResultForExport` 聚合全量 rows。
3. DataGrid 去掉或延迟 `displayItems` 全量数组，搜索命中做分批扫描和上限。
4. Data Compare 加行数阈值、确认提示和 diff 明细分页。
5. Redis `fetch all`、value search、command history 加上限。

中期优化：

1. Data Compare 改为主键有序流式对比或 hash 摘要对比。
2. tab result cache 改成分块序列化，减少落盘时的峰值副本。
3. QueryChart 加采样和最大点数。
4. Mongo table mode 对对象字段做懒格式化。

长期优化：

1. 加内存诊断面板，显示当前 tab rows、列数、派生索引数量、缓存结果数量。
2. 在开发和生产 Tauri 下分别采集 JS heap snapshot，建立固定的大数据压测场景。
3. 对 Rust 后端的 Data Compare、Agent cursor、JDBC session 做 heap / allocation profile。

## 需要进一步实测

本报告没有拿到用户实际数据库数据集，因此功能排序主要基于代码路径和当前进程快照。若要定位“现在”具体是哪一个功能占用最多，建议补跑以下场景：

1. 生产 Tauri 包下打开空应用，记录基线 RSS。
2. 执行 10k、50k、100k 行查询，分别记录 DataGrid 首屏、搜索、切 tab、导出时的 JS heap 和 RSS。
3. 对比 10 万、100 万行表，记录 Rust 进程峰值内存。
4. Redis 分别加载 10k、100k、1M keys，记录 flat/tree/visibleRows 的前端 heap。
5. Mongo 表格视图加载宽文档和深嵌套文档，比较 document mode 与 table mode。

如果只看当前代码风险，首要优化对象应是“查询结果/DataGrid/导出”和“数据对比”。
