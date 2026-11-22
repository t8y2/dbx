# 快捷搜索统一搜索计划

## 产品目标与边界

快捷搜索是面向“定位并打开对象”的统一入口，目标是让用户用一次快捷键完成连接、数据库、Schema、表、视图、函数、字段、注释、SQL 文件、文件内容和插件命令的查找与导航。

第一版只搜索对象元数据和文件内容：

- 元数据来源是本地缓存，以及当前已经连接的数据库。
- 搜索过程不能因为输入关键词而自动连接冷数据库。
- 数据库真实数据内容继续使用独立的数据库搜索面板。
- SQL 数据库优先接入字段和注释；非 SQL 数据库继续沿用已有结果，并按驱动能力逐步扩展。
- 每个结果必须能说明上下文和来源，并具备明确的打开行为。

## 统一结果模型

`apps/desktop/src/lib/quickOpen/quickSearch.ts` 定义 `QuickSearchResult`、查询解析、显式过滤、来源推断和元数据索引。`QuickOpenItem` 继承该协议，保留文件、内容搜索和插件导航字段，避免现有调用方产生破坏性变更。

支持的结构化过滤语法：

- `kind:column email`
- `db:analytics order`
- `schema:public customer`
- `comment:用户`
- `file:report`
- `kind:file report`
- `connection:production`
- `source:remote email`
- `category:files report`

过滤条件先执行，名称和元数据匹配再排序。这样 `kind:column db:analytics email` 不会被另一个数据库中的同名表干扰。

## 三个版本

### V1：统一入口和字段搜索

- 统一缓存结果、已连接数据库增量结果、SQL 文件、文件内容和插件命令的结果模型。
- 缓存树节点即时进入增量索引；远程表和结构目录查询按连接/数据库并发执行。
- 支持字段名、字段注释、表注释命中，并导航到结构编辑器的字段位置。
- 支持 generation 校验、取消旧查询、远程批次发布、结果去重和来源标识。
- 结果按对象、文件、命令分组，组内按匹配质量排序。
- 完成快捷搜索和结构搜索自动化测试。

### V2：索引和交互增强

- 将连接元数据缓存升级为可增量更新的按连接/数据库索引，减少每次输入的全量扫描。（已在统一快捷搜索索引中完成条目复用，并通过 Quick Open metadata snapshot 和侧栏表索引支持跨重启的 last-known 离线搜索。）
- 为更多 SQL 驱动补齐 Catalog 能力，按 manifest 能力声明决定是否执行远程结构搜索。
- 复用已有文档型元数据 API，接入 MongoDB、Elasticsearch、Neo4j、InfluxDB 和 Milvus 的集合/字段搜索。
- 增加结果类别分组、类别计数、来源过滤和更完整的预览上下文。
- 补齐结构化语法的组合条件、引号转义和字段/注释高亮。

### V3：跨数据库和行为对照

- 评估 MongoDB、Elasticsearch、Neo4j、InfluxDB、Milvus 等非 SQL 数据库的对象索引适配器。
- 增加索引失效、连接状态变化、驱动切换和大型工作区下的性能指标。当前已覆盖连接状态过滤、generation 失效和条目级增量复用。
- 对照 DataGrip 验证分类结果、字段命中、上下文显示、键盘导航、取消搜索和打开行为。

## 文件改造清单

- `apps/desktop/src/lib/quickOpen/quickSearch.ts`：统一协议、查询解析、过滤、索引和匹配字段。
- `apps/desktop/src/composables/useQuickOpen.ts`：本地索引优先、远程增量搜索、取消、generation、排序和去重。
- `apps/desktop/src/components/quick-open/QuickOpenDialog.vue`：统一结果列表、来源标记、过滤条件提示和对象/文件模式切换。
- `apps/desktop/src/App.vue`：字段、对象、文件和插件结果的打开路由。
- `apps/desktop/src/lib/database/databaseStructureSearch.ts` 与 Catalog API：复用结构搜索能力。
- `apps/desktop/src/composables/__tests__/useQuickOpen.spec.ts`：语法、缓存字段、远程字段、取消和旧响应回归测试。

## 验收标准

- 输入普通关键词可命中名称精确、前缀、单词前缀、子串、拼音和模糊结果。
- 字段名、字段注释和表注释可以命中，并显示数据库、Schema、表和来源上下文。
- `kind`、`db`、`schema`、`comment`、`file`、`connection`、`source`、`category` 过滤条件可以组合使用。
- 搜索先显示缓存结果；远程结果按批次到达并保持排序稳定。
- 类别计数表示当前合并结果池，不代表数据库全量实时对象数。
- 冷数据库不会因打开快捷搜索而建立连接。
- 新关键词出现后旧查询被取消或其结果被 generation 丢弃。
- 同一连接、数据库、Schema、对象或字段不会因为缓存和远程结果重复显示。
- Enter、双击和方向键导航均打开正确目标；字段进入结构编辑器并定位字段。
- 真实数据搜索仍由独立数据库搜索面板承载。
- 相关 Vitest、格式检查、diff 检查和 TypeScript 检查结果可追溯。

## DataGrip 对照结论

当前实现已对齐以下核心行为：统一快捷入口、按名称和上下文搜索、字段与注释命中、结构化过滤、对象/文件/命令结果分组、结果上下文、键盘导航、异步补充和旧结果丢弃。

后续对照重点是结果分组与类别计数、搜索语法的完整兼容范围、远程索引刷新策略，以及各数据库驱动的对象打开行为。真实数据内容搜索保持独立，避免快捷入口在输入普通关键词时执行数据扫描。
