# MCP 能力平台化设计方案

> 状态：方向已确认（见 §10），P0–P4 已完成，收尾验证记录见 §9
> 范围：MCP 的接入、能力（工具）注册与管理、权限模型、管理界面
> 前置文档：[mcp-management-layout-redesign.md](./mcp-management-layout-redesign.md)（接入方式 / 权限管理两 Tab 布局）

## 1. 背景与问题

DBX 的 MCP Server 最初只服务 SQL 类数据库，现在已经覆盖 Redis、MongoDB、消息队列、Salesforce、连接管理、工作台联动和插件工具。后续还会陆续接入 Nacos、Consul、etcd、ZooKeeper、Elasticsearch、MQTT、向量库等各类非 SQL 产品，以及更多插件。现有设计是围绕 SQL 长出来的，继续堆功能会遇到下面这些问题。

### 1.1 现状盘点

| 维度 | 现状 | 代码位置 |
|---|---|---|
| 接入 | stdio（独立二进制 `dbx-mcp`）+ Streamable HTTP（单 Bearer Token），已经稳定 | `crates/dbx-mcp/src/{transport,http,http_auth}.rs` |
| 内置工具 | 28 个静态工具，平铺在一个列表里 | `crates/dbx-mcp/src/server.rs` 的 `#[tool(name = ...)]` |
| 工具开关 | `allowed_tool_names: Option<Vec<String>>` 扁平白名单；插件靠 `dbx_<prefix>__*` 通配符 | `server.rs::policy_allows_tool` |
| 执行权限 | `read_only` + `allow_dangerous_sql` 两个布尔值，按 全局 → 分组 → 连接 → 单库 逐级覆盖 | `dbx-core/src/ai/mcp_policy.rs` |
| 资源范围 | 分组/连接白名单 + 连接下的 `database_scope`（All/Selected/None） | `persistence/storage.rs::McpConnectionPolicy` |
| 特例开关 | `allow_salesforce_dml` 直接挂在连接策略上 | `storage.rs`、`mcp_policy.rs::connection_allows_salesforce_dml` |
| 插件工具 | 插件作者在 manifest 里声明 `mcp.external_tools: true` 才会对外暴露；只读判定只看 `readOnlyHint`；暴露方式由环境变量 `DBX_MCP_PLUGIN_TOOLS=flat/lazy/both` 控制 | `dbx-mcp/src/plugin_tools.rs`、`plugin-runtime/.../manifest.rs` |
| 插件 AI 开关 | 插件中心里有“内置 AI 可用”的用户开关（`ai_plugin_tool_plugins`）；**外部 MCP 没有用户侧开关** | `PluginAiAccessSection.vue` |
| 确认 | `prompt_high_risk_sql`：安全写模式下，高危 SQL 需要桌面端确认 | `McpSqlApprovalDialog.vue` |
| 非 SQL 产品 | Redis、MQ、Salesforce 各自零散地加了专用工具，没有统一规范；Nacos、Consul 等已有完整管理能力（`dbx-core/src/admin/*`），**MCP 还没接** | — |

### 1.2 核心问题

1. **权限语义只适用于 SQL。** `read_only` / `allow_dangerous_sql` 套在 Nacos（发布配置、下线实例）、Consul（写 KV、改 ACL）、MQ（发消息、清队列）、插件（SSH 执行命令）上都不准确。每接一种新能力，就会多一个 `allow_salesforce_dml` 这样的专用字段，策略结构会越来越碎。
2. **“数据库范围”这一层没有抽象。** 在 Nacos 里是 namespace/group，在 Consul 里是 datacenter/KV 前缀，在 Kafka 里是 topic，在插件里可能是 K8s namespace，但现在只有 `database_name` 一种表达。
3. **工具列表平铺，而且跟连接类型无关。** 用户没有任何 Salesforce 连接，界面上照样出现 3 个 Salesforce 勾选项；28 个工具加上插件工具（上限 512 个），既让界面变得复杂，也会浪费客户端的上下文。
4. **插件管理分散在两处。** 内置 AI 的开关在插件中心，外部 MCP 只能靠作者声明加上权限页里的通配符白名单，用户没法以插件为单位清楚地控制“这个插件对 MCP 是否开放、开放到什么程度”。
5. **插件工具的风险只能二选一。** 只有“是否只读”，无法区分普通写入和破坏性操作，确认机制也只覆盖 SQL。
6. **独立二进制存在版本差。** `dbx-mcp` 和桌面端分别升级，策略文件的格式一旦变化，老版本二进制必须仍然安全（不能因为看不懂新字段而放宽权限）。

## 2. 设计目标与原则

- **一个统一的权限心智模型**：不管是 SQL、Nacos 还是插件，用户面对的都是“这个资源能 不可访问 / 只读 / 读写 / 完全访问”。
- **能力按“提供方 → 工具集 → 工具”三层组织**：界面默认只操作到工具集（或插件）这一层，单个工具的开关作为高级选项。
- **权限 = 资源 × 级别**，工具只声明“我需要什么级别”。用户不需要把每个工具和每个连接一一配对。
- **内置和插件同构**：内置的 SQL、各产品能力和插件能力走同一套描述符、同一套判定、同一个界面。
- **按产品接入，规范统一**：每个非 SQL 产品作为独立的提供方，工具贴合产品自身模型；所有产品遵守同一份接入规范（§5），Nacos、Consul 只是首批示例，后续产品一律照此执行。
- **只有一份全局策略**：所有 MCP 客户端共用 DBX 当前的权限管理，不引入按客户端区分的多套策略。
- **默认简单**：全局默认权限负责统一默认值；需要单独权限时在访问控制树中设置。
- **默认安全、失败时拒绝**：没有声明的视为写入；新出现的高级别工具默认不开放；老版本二进制只读取一份“不会比新策略更宽”的投影。
- **兼容平滑**：现有策略能无损映射到新模型，迁移后行为不变。

## 3. 核心抽象

### 3.1 三层能力模型

```text
能力提供方 Provider          工具集 Toolset                   工具 Tool
────────────────────        ─────────────────────           ───────────────────────────
builtin:core                 发现与上下文                     list_connections / list_databases / get_schema_context ...
builtin:sql                  SQL 查询                         execute_query / execute_batch
                             会话与事务                       open_session / begin / commit / rollback / close
                             对象结构                         list_tables / describe_table / list_routines / get_routine_source
builtin:redis                Redis                           execute_redis_command
builtin:mq                   消息队列                         peek_messages / send_message
builtin:salesforce           Salesforce                      salesforce_current_user / prepare_write / apply_write
builtin:<product>  (新)      按 §5 规范，每个产品一个提供方     dbx_<product>_* ……
  例 builtin:nacos           Nacos 配置 / Nacos 服务 / Nacos 管理（默认关闭）
  例 builtin:consul          Consul KV / Consul 服务 / Consul 管理（默认关闭）
  后续 etcd / zookeeper / elasticsearch / mqtt / milvus …… 同样方式接入
builtin:workbench            工作台联动                       open_table / execute_and_show
builtin:admin                连接管理                         add_connection / duplicate_connection / remove_connection
plugin:<pluginId>            由插件声明（默认一个工具集）       由插件 mcp/tools 返回
```

- **Provider（提供方）**：权限和启停的归属单位。内置提供方随 DBX 版本发布；每个插件就是一个提供方。
- **Toolset（工具集）**：界面上的开关单位，也是 `tools/list` 裁剪的单位。
- **Tool（工具）**：协议层的实际工具，带一份静态描述符。

### 3.2 工具描述符（Tool Descriptor）

内置工具不再只在 UI 里写死名称，而是在后端集中注册一份描述符表，UI 通过接口拉取：

```rust
pub struct ToolDescriptor {
    pub name: &'static str,            // dbx_execute_query
    pub provider: ProviderId,          // builtin:sql / plugin:io.dbx.ssh
    pub toolset: &'static str,         // sql.query
    /// 工具可能触及的最高访问级别。
    pub access: AccessLevel,           // Read | Write | Full
    /// 级别是静态的，还是由运行时分类器逐次判定（例如 SQL 风险分析）。
    pub access_mode: AccessMode,       // Static | Classified
    /// 工具作用于哪类资源；None 表示不绑定连接（例如 add_connection）。
    pub resource: Option<ResourceKind>,// Connection { kinds: &[ConnectionKind] }
    /// 是否接受子范围参数，例如 database / namespace / topic。
    pub scope_kind: Option<ScopeKind>,
    /// 适用连接类型的计算方式（用于界面上的“覆盖范围”说明，见 §5.5）。
    pub coverage: Coverage,            // Static(&[DatabaseType]) | Capability(CapabilityKey)
}
```

- `access_mode = Classified`：工具本身声明最高级别为 Full，每次调用时由分类器给出实际级别。`execute_query` 继续复用 `sql_risk`：SELECT 判为 Read，普通 DML 判为 Write，DDL/DROP/TRUNCATE 判为 Full。`dbx_nacos_publish_config` 是静态的 Write，`dbx_nacos_delete_config` 是静态的 Full。
- `resource.kinds` 声明适用的连接类型。如果当前**没有任何可见连接**属于这些类型，这个工具集就在 `tools/list` 和界面里自动隐藏（界面上灰显，并提示“无可用连接”）。这样同时解决了“Salesforce 勾选项常驻”和“工具太多”这两个问题。
- `coverage = Capability(...)`：适用类型不写死，而是从驱动清单 `crates/dbx-core/assets/database-drivers.manifest.json` 中按能力位计算（例如 `queryExecution`、`objectSource`、`metadataBrowse`）。新增或调整一个驱动时，工具的覆盖范围和界面说明自动更新，不需要改 MCP 代码。

### 3.3 统一访问级别

| 级别 | 含义 | SQL | MongoDB | Redis | MQ | 其他产品（以 Nacos / Consul 为例） | 插件 |
|---|---|---|---|---|---|---|---|
| 不可访问 | 对 MCP 不可见 | — | — | — | — | — | — |
| 只读 Read | 不改变状态 | SELECT / EXPLAIN | find / aggregate（无 `$out`） | GET 类命令 | peek | 查询配置、服务、KV | `access = read` |
| 读写 Write | 可逆或常规的变更 | INSERT / UPDATE / DELETE（带条件） | insert / update | SET 类命令 | send | 发布配置、注册/修改实例、写 KV | `access = write` |
| 完全 Full | 破坏性、批量或结构变更 | DDL、DROP、TRUNCATE、无 WHERE 的 DML | drop、`$out` 跨库 | FLUSH*、DEL 模式匹配 | 删除 topic、清空队列 | 删除配置/命名空间、ACL 变更 | `access = full` |

**与现有字段无损映射：**

| 现有 `(read_only, allow_dangerous_sql)` | 新级别 |
|---|---|
| `(true, *)` | Read |
| `(false, false)` | Write |
| `(false, true)` | Full |

`allow_salesforce_dml` 等专用字段会被收编：Salesforce 写入在描述符里声明为 Write，由连接的访问级别控制，不再需要单独字段。迁移时，连接上的 `allow_salesforce_dml=false` 会被转成一条“该连接上 Salesforce 写入工具的上限为 Read”的规则，保证迁移后行为不变（详见 §6）。

### 3.4 资源与子范围

```text
全局默认
└── 分组（可嵌套，沿用侧边栏分组 id）
    └── 连接（内置类型或插件连接，plugin_id 区分）
        └── 子范围 Scope（由连接类型声明种类）
            SQL / Mongo  → database（可选 schema）
            Redis        → db index
            其他产品      → 由产品提供方按 §5 声明，例如 Nacos → namespace，Consul → datacenter / KV 前缀
            Kafka 等     → topic / queue 模式
            插件         → 插件在 manifest 中声明的 scope kind，由插件提供列举方法
```

每个节点上可以配置：

- **可见性**：继承 / 可见 / 不可见。
- **访问级别**：继承 / 不可访问 / 只读 / 读写 / 完全。

继承顺序与现有规则一致：**子范围 > 连接 > 最近的分组 > 上级分组 > 全局默认**。

**调用安全**独立于资源继承，由全局策略统一决定高危调用是否逐次确认。节点权限不能关闭这项确认要求；旧版临时授权仅为兼容保留，详见文末“调用安全语义与兼容”。

### 3.5 判定公式

一次工具调用最终是否被允许：

```text
allowed =
      provider.enabled                              // 插件或内置能力已开启
  AND toolset.enabled AND tool.enabled              // 工具层开关
  AND resource.visible                              // 连接 / 子范围可见
  AND call_level ≤ effective_level(resource)        // 级别比较
  AND call_level ≤ provider.ceiling                 // 插件授权上限（§4.3）
  AND hard_protections(resource, call_level)        // 连接只读保护、生产保护、跨库校验等，永远是上限

call_level = tool.access_mode == Classified ? classify(call) : tool.access

needs_confirm = allowed AND confirm == high_risk AND is_high_risk(call)
```

以上为新策略：先授权，再确认；批准后重新校验权限和硬保护。旧 `confirm=full` 不采用新的语义，继续保留原先 Write 经确认临时执行部分 Full 操作的行为，直到用户主动迁移。

- **不绑定连接的工具**（`add_connection`、插件中与连接无关的工具）：`resource` 取“提供方自身”，级别和全局默认比较。另外延续现有规则：在有作用域的会话里，没有任何可见连接的插件，它的无连接工具也不可用，避免成为绕过限制的侧门。
- **跨资源调用**（SQL 引用其他库、Mongo 的 `$out`/`$merge`）：延续现有 `ensure_*_database_execution_scope`，推广成“分类器必须返回调用触及的所有子范围”，每个子范围都单独判定。
- **`tools/list` 裁剪**：工具只有在至少一个可见资源的生效级别 ≥ 该工具的最低可用级别时才会出现。例如全部资源都是只读时，`commit_transaction`、`send_message` 之类的工具不会出现在列表里，减少客户端上下文；但调用时的判定仍是权威的。

## 4. 插件 MCP 能力

### 4.1 Manifest 扩展

在现有 `mcp.ai_tools` / `mcp.external_tools` 基础上扩展，所有新字段都可选：

```toml
[mcp]
ai_tools = true            # 内置 AI 是否可以使用（作者上限）
external_tools = true      # 外部 MCP 是否可以使用（作者上限）

# 可选：工具分组。不声明时整个插件就是一个工具集。
[[mcp.toolsets]]
id = "files"
title = "文件浏览"
[[mcp.toolsets]]
id = "shell"
title = "远程命令"

# 可选：逐个工具声明级别与分组。不声明时根据 MCP annotations 推断。
[mcp.tools.sftp_list_dir]
toolset = "files"
access = "read"
[mcp.tools.ssh_exec]
toolset = "shell"
access = "full"

# 可选：子范围。插件可以让用户按 K8s namespace、目录等进一步限定。
[mcp.scope]
kind = "namespace"
title = "命名空间"
list_method = "mcp/scopes"     # sidecar 方法，返回某个连接下可选的范围
argument = "namespace"         # 工具调用里承载范围的参数，由宿主校验
```

**级别推断（未声明时）**：`readOnlyHint = true` → Read；`destructiveHint = true` → Full；其他情况一律视为 Write。这和现有“只读模式下拒绝未声明只读的插件工具”保持一致。

`mcp/tools` 运行时返回的工具如果不在 manifest 声明里，就按推断处理，并在界面上标注“未声明级别”。

### 4.2 以插件为单位管理（参考 uTools）

- **一个插件对应一张卡片、一个总开关**：开关含义是“这个插件的工具对外部 MCP 开放”。作者的 `external_tools = false` 是硬上限，此时开关禁用，并显示“插件作者未开放”。
- **内置 AI 和外部 MCP 共用一份存储**：存成 `plugin_capability_grants[pluginId] = { ai: bool, mcp: bool, ceiling, approvedTools, ... }`。插件中心和 MCP 设置编辑的是同一份数据，两边都能看到两个开关，避免出现两套状态。现有的 `ai_plugin_tool_plugins` 迁移到 `grants[*].ai`。
- **首次开启时做一次授权确认**（类似 OAuth scope）：弹窗列出插件的工具集和级别，用户选择授权上限（只读 / 读写 / 完全，默认取“插件声明的最高级别”和“读写”中较低的一个）。
- **插件升级后的变化**：
  - 新增只读工具在授权上限内可跟随插件开关自动可用；新增非只读工具仍需用户确认。
  - 新增非只读工具，或已有工具的声明级别升高到非只读级别 → 默认不可用，卡片上显示待确认状态；工具超过授权上限时仍保持隐藏。
- **插件的连接仍然走资源树**：插件连接本来就是 DBX 连接（`plugin_id` 非空），所以连接可见性、访问级别、子范围都在同一棵树里配置，不需要单独做一套。

### 4.3 插件工具对外提供方式

在“能力 → 高级配置”提供默认折叠的设置，控制 DBX 如何向 MCP 客户端提供已授权的插件工具，点击底部“应用”后生效：

- **直接列出（新配置默认）**：逐个提供已授权工具，对应 `flat`。
- **按需发现**：通过 `dbx_plugin_list` / `dbx_plugin_tools` / `dbx_plugin_call` 查询与调用，对应 `lazy`，需开启“DBX 通用 → 插件发现与调用”。
- **自动（兼容模式）**：保留原有行为，插件工具总数 ≤ 40 时直接列出，超过时按需发现。已有模式不迁移；旧配置缺少该字段时保持原有自动行为。

环境变量继续保留，用于覆盖设置。

## 5. 产品能力接入规范

> **适用范围：所有非 SQL 产品，包括现在已有的和以后新增的。** 下文的 Nacos、Consul 只是用来说明规范的首批示例，不是特例。etcd、ZooKeeper、Elasticsearch、MQTT、Milvus / Qdrant 等向量库、InfluxDB、Neo4j……以后任何产品接入 MCP，都必须按本节执行；Redis、MQ、Salesforce 这些已有的专用工具也逐步对齐到本规范。

### 5.1 什么时候共用工具，什么时候按产品区分

| 情况 | 做法 | 例子 |
|---|---|---|
| 多个产品共享一门 DBX 已经统一处理的查询语言 | 共用通用工具，由方言层处理差异 | 所有 SQL 数据库共用 `dbx_execute_query`、`dbx_describe_table` 等 |
| 产品有自己的数据模型、命令或 API | **按产品单独提供工具**，不做跨产品抽象 | Nacos、Consul、Redis、Elasticsearch、MQTT …… |

按产品区分的原因：各产品功能虽然相近，但细节差异大（Nacos 的 dataId + group + namespace 与配置回滚；Consul KV 的 CAS / ModifyIndex 与 datacenter；etcd 的 revision 与 lease）。强行统一要么丢能力，要么参数里塞满“仅某产品有效”的字段，模型调用时容易出错。

### 5.2 接入清单

每个产品作为一个内置提供方 `builtin:<product>`，接入时必须提供以下内容：

| 项 | 要求 |
|---|---|
| 提供方 | id 为 `builtin:<product>`；声明适用的连接类型（`db_type`），默认一个连接类型对应一个提供方 |
| 工具命名 | `dbx_<product>_<动作>_<对象>`，例如 `dbx_nacos_publish_config`。不得包含 `__`（`dbx_<prefix>__<tool>` 保留给插件） |
| 工具集划分 | 按业务场景拆分，例如“配置”“服务”“KV”。日常场景的工具集默认开启；用户、角色、权限、命名空间增删等管理类操作统一放进“<产品> 管理”工具集，**默认关闭** |
| 不暴露的操作 | 快照恢复、集群成员变更、License 写入、任意原始 API 透传等集群级或无法判定风险的操作，不提供 MCP 工具 |
| 访问级别 | 每个工具在描述符里声明 Read / Write / Full（§3.3）。产品有自己的命令语言时（如 Redis），提供分类器逐次判定（`Classified`） |
| 子范围 | 声明本产品的子范围种类（如 namespace、datacenter、db index、index、topic），并提供列举方法，供访问控制树懒加载；带子范围的工具必须把它作为显式参数，由宿主校验 |
| 硬保护 | 复用连接只读保护、生产保护；产品自身已有的写保护（如 Consul 的 `ensure_writable_core`）继续生效 |
| 实现位置 | 业务逻辑复用 `dbx-core/src/admin/<product>` 中已有的实现；MCP 层（`dbx-mcp/src/providers/<product>.rs`）只做参数映射、权限判定和结果整形，不重复实现业务 |
| 确认预览 | Write / Full 工具需要给确认弹窗提供变更摘要：发布类给出前后 diff，批量删除类先预览影响范围 |
| 界面与文案 | 工具集标题、说明和工具说明提供中英文 i18n；能力 Tab 自动生成卡片，不需要为产品单独写界面 |
| 测试 | 描述符完整性测试（每个工具都有工具集、级别、适用连接类型）；权限判定测试（各级别 × 子范围）；至少一条正常调用的集成测试 |

满足清单后，判定、`tools/list` 裁剪、能力 Tab、访问控制树、确认弹窗、调用记录全部自动复用，**不需要为单个产品改动框架或界面**。

### 5.3 示例

以下两个示例说明规范如何落到具体产品上。后续产品按同样的格式在本节补一张表即可。

#### 示例一：Nacos

实现复用 `crates/dbx-core/src/admin/nacos` 中已有的 `nacos_*_core` 函数。子范围：namespace。

| 工具集 | 工具 | 级别 | 对应现有实现 |
|---|---|---|---|
| Nacos 配置（默认开启） | `dbx_nacos_list_configs` | Read | `nacos_list_configs_core` |
| | `dbx_nacos_get_config` | Read | `nacos_get_config_core` |
| | `dbx_nacos_search_configs` | Read | `nacos_search_config_content_core` |
| | `dbx_nacos_config_history` | Read | `nacos_list_config_history_core` / `nacos_get_config_history_core` |
| | `dbx_nacos_publish_config` | Write | `nacos_publish_config_core` |
| | `dbx_nacos_rollback_config` | Write | `nacos_rollback_config_core` |
| | `dbx_nacos_delete_config` | Full | `nacos_delete_config_core` |
| Nacos 服务（默认开启） | `dbx_nacos_list_services` | Read | `nacos_list_services_core` |
| | `dbx_nacos_get_service` | Read | `nacos_get_service_core` |
| | `dbx_nacos_list_instances` | Read | `nacos_list_instances_core` |
| | `dbx_nacos_update_instance` | Write | `nacos_update_instance_core`（上下线、权重、元数据） |
| | `dbx_nacos_register_instance` / `dbx_nacos_deregister_instance` | Write / Full | `nacos_register_instance_core` / `nacos_deregister_instance_core` |
| Nacos 管理（默认关闭） | `dbx_nacos_list_namespaces` | Read | `nacos_list_namespaces_core` |
| | `dbx_nacos_create_namespace` / `update` / `delete` | Write / Write / Full | `nacos_*_namespace_core` |
| | `dbx_nacos_list_users` / 用户与角色变更 | Read / Full | `nacos_*_user_core`、`nacos_assign_role_core` 等 |

- 发布配置要求传入 `content` 和 `type`；如果当前配置存在，返回的结果里带上变更前后的摘要，方便确认弹窗展示 diff。
- `dbx_nacos_list_namespaces` 在“管理”工具集关闭时，仍然会以只读方式出现在“Nacos 配置”工具集中（模型需要知道有哪些 namespace），但只列出访问控制树中可见的 namespace。

#### 示例二：Consul

实现复用 `crates/dbx-core/src/admin/consul` 中已有的 `consul_*_core` 函数。子范围：暂无——一个 Consul 连接本身就对应一个 datacenter，按 datacenter 细分没有意义；KV 前缀级授权留待需要时再加。

| 工具集 | 工具 | 级别 | 对应现有实现 |
|---|---|---|---|
| Consul KV（默认开启） | `dbx_consul_kv_list` | Read | `consul_list_prefix_core` / `consul_list_recursive_core` |
| | `dbx_consul_kv_get` | Read | `consul_get_core` |
| | `dbx_consul_kv_put` | Write | `consul_put_core`（支持 `cas` ModifyIndex） |
| | `dbx_consul_kv_delete` | Full | `consul_delete_core`；按前缀删除走 `consul_delete_prefix_preview_core` → `execute`，并强制确认 |
| Consul 服务（默认开启） | `dbx_consul_list_services` | Read | `consul_catalog_services_core` |
| | `dbx_consul_service_health` | Read | `consul_health_service_core` / `consul_health_checks_core` |
| | `dbx_consul_list_nodes` | Read | `consul_catalog_nodes_core` |
| | `dbx_consul_set_maintenance` | Write | `consul_agent_service_maintenance_core` |
| Consul 管理（默认关闭） | `dbx_consul_acl_list` / `get` | Read | `consul_acl_list_core` / `consul_acl_get_core` |
| | `dbx_consul_acl_apply` / `delete` | Full | `consul_acl_apply_core` / `consul_acl_delete_core` |
| | `dbx_consul_intention_*` | Read / Full | `consul_mesh_intention_*_core` |

- 快照恢复、Raft 操作、License 写入这类集群级危险操作**不暴露给 MCP**。
- 已有的 `ensure_writable_core`（连接只读保护）继续作为硬保护生效。

### 5.4 已有产品对齐与后续产品

| 产品 | 现状 | 对齐方式 |
|---|---|---|
| Redis | `dbx_execute_redis_command` | 归入 `builtin:redis`；命令分类器给出级别；子范围为 db index |
| 消息队列 | `dbx_peek_messages` / `dbx_send_message` | 归入 `builtin:mq`；子范围为 topic / queue；补充描述符 |
| Salesforce | 3 个专用工具 + `allow_salesforce_dml` 字段 | 归入 `builtin:salesforce`；写入由访问级别控制，专用字段按 §6.2 迁移后移除 |
| etcd、ZooKeeper、Elasticsearch、MQTT、向量库等 | 未接入 MCP | 按需排期，接入时按 §5.2 清单执行，并在 §5.3 补示例表 |

插件提供的产品能力通过 manifest（§4.1）声明同样的信息：工具集、访问级别、子范围。内置产品和插件产品遵守同一份规范。

### 5.5 SQL 类数据库与通用查询工具

SQL 类数据库是 §5.1 中“共用通用工具”的情况，**不按数据库拆分工具**。现有工具、名字和行为全部保留，只纳入本方案的统一框架。

#### 5.5.1 在新框架中的位置

| 方面 | 处理方式 | 行为是否变化 |
|---|---|---|
| 工具 | 现有工具全部保留、名字不变，分成“SQL 查询”“会话与事务”“对象结构”三个工具集 | 不变 |
| 发现类工具 | `list_connections` / `list_databases` / `get_schema_context` 归入“发现与上下文”，所有连接类型共用 | 不变 |
| 访问级别 | 只读 → 只读；安全写 → 读写；允许高危 SQL → 完全访问 | 不变 |
| 逐条判定 | 继续用 `sql_risk`：SELECT 为只读，普通 DML 为读写，DDL / DROP / TRUNCATE / 无条件 DML 为完全访问 | 不变 |
| 继承 | 全局 → 分组 → 连接 → 单库；单库是子范围的一种（种类为 database） | 不变 |
| 跨库校验 | SQL 引用其他库、Mongo `$out` / `$merge` 写到其他库的校验继续生效 | 不变 |
| 确认 | 独立调用安全在授权后逐次确认高危调用，完全访问也遵循；旧 `prompt_high_risk_sql` 保留临时授权语义，主动切换才迁移 | 新策略与旧配置分别处理 |
| 硬保护 | 连接只读保护、生产保护保持不变，永远是上限 | 不变 |

**MongoDB**：现在也通过 `dbx_execute_query` 执行 shell 命令。近期保留这条路径以兼容现有配置，级别判定改用 MongoDB 命令分类；后续按 §5.2 新增 `builtin:mongodb` 提供专用工具，`dbx_execute_query` 对 MongoDB 的支持只保留兼容，不再扩展。

#### 5.5.2 覆盖范围说明（界面提示）

通用工具一次覆盖几十种数据库，但**不同工具覆盖的范围并不相同**。例如“存储过程源码”只有部分数据库支持，`execute_query` 则覆盖所有能执行查询的连接。用户需要在配置和使用时清楚知道每组工具对哪些数据库生效。

**数据来源**：覆盖范围由描述符的 `coverage` 从驱动清单的能力位计算，不在界面上写死：

| 工具集 / 工具 | 计算依据 | 当前覆盖（按 2026-10 驱动清单统计） |
|---|---|---|
| SQL 查询：`execute_query` | `capabilities.queryExecution` | 78 种：关系型、国产、轻量、分析型、时序、部分搜索/文档 |
| SQL 查询：`execute_batch` | `capabilities.sqlFileExecution` | 64 种：关系型、国产、轻量、分析型等 |
| 会话与事务 | 静态声明，与 `transaction_connection_supported` 保持一致 | 目前只有 MySQL（原生驱动）；其他类型可以开会话，但不能开启事务 |
| 对象结构：`list_tables` / `describe_table` | `capabilities.metadataBrowse` | 76 种 |
| 对象结构：`list_routines` / `get_routine_source` | `capabilities.objectSource` | 31 种：MySQL、PostgreSQL、SQL Server、Oracle、DB2、达梦、金仓等 |

不支持 MCP 的类型（清单中 `mcpMode = "unsupported"`，如 Nacos、Consul、MQ、MQTT）不计入通用工具的覆盖，它们按 §5.2 由各自的产品提供方覆盖。

**界面上分三层展示，从简到详：**

1. **卡片摘要**（能力 Tab 卡片第二行）：一句话写明覆盖范围，并标出用户当前有多少连接会用到这组工具。

   ```text
   [≡] SQL 查询      execute_query · execute_batch          读 写 高危   2/2  [●]
       适用 78 种数据库 · 你有 6 个连接会用到                              [查看覆盖]
   [≡] 对象结构      4 个工具                                读          4/4  [●]
       表结构适用 76 种 · 存储过程仅 31 种 · 你有 6 个连接会用到             [查看覆盖]
   ```

2. **覆盖详情**（点击“查看覆盖”或卡片抽屉中的“覆盖范围”页签）：按连接分类分组列出数据库，分组沿用新建连接时的分类（关系型、国产、轻量、分析型、文档与搜索、时序、图与向量），用户熟悉。

   ```text
   覆盖范围 · 对象结构                                  [搜索数据库…]
   ┌─────────────────────────────────────────────────────────────────┐
   │ 工具             关系型  国产   轻量   分析型  文档/搜索  时序   图/向量 │
   │ 列出表 / 表结构    ✓      ✓      ✓      ✓      部分       ✓      部分   │
   │ 存储过程列表/源码  ✓      ✓      部分    —      —          —      —      │
   └─────────────────────────────────────────────────────────────────┘
   关系型（9）  MySQL ✓  PostgreSQL ✓  SQL Server ✓  Oracle ✓  DB2 ✓ …
   国产（16）   达梦 ✓  金仓 ✓  瀚高 ✓  GaussDB ✓  OceanBase Oracle ✓ …
   ……
   ● 你已有连接的类型高亮显示；“部分”可展开看到具体哪些支持、哪些不支持
   ```

3. **连接维度提示**（访问控制树）：连接行悬停或展开时，显示“这个连接可用的 MCP 工具集”，例如 `local-mysql-v8：SQL 查询 · 会话与事务 · 对象结构（含存储过程）`；`local-redis-v7：Redis 命令`。用户在给连接授权时就能看到授权后实际能用哪些工具。

**其他场景的提示：**

- 用户有某种类型的连接，但**没有任何工具集覆盖它**（例如 Nacos 尚未接入时）：在访问控制树该连接行显示“暂无 MCP 工具”，并在能力 Tab 顶部给出一条汇总提示：“有 2 个连接的类型暂不支持 MCP：dev-nacos、prod-consul”。
- 工具集**部分覆盖**用户已有的连接（例如有 SQLite 连接，但存储过程工具不支持 SQLite）：卡片摘要显示“你的 1 个连接不支持其中部分工具”，展开后列出具体连接与工具。
- 发给 MCP 客户端的工具说明（`description`）末尾同样附上一句简短的覆盖说明，例如 “Supported on relational, analytical and time-series databases; not on Redis or MongoDB.”，让模型也知道不该对不支持的连接调用；调用不支持的连接时，返回的错误里列出该连接可用的工具。

## 6. 策略数据模型 v2 与迁移

### 6.1 结构

```jsonc
{
  "version": 2,
  "defaults": { "access": "read", "confirm": "full" },
  "visibility": { "mode": "all" },                     // 或 { "mode": "selected" }，范围由 rules 的 visible 决定
  "rules": [
    { "target": { "group": "g-prod" },                       "access": "read" },
    { "target": { "connection": "c-mysql-dev" },             "access": "full", "visible": true },
    { "target": { "scope": { "connection": "c-mysql-dev", "kind": "database", "value": "billing" } }, "access": "read" },
    { "target": { "connection": "c-nacos" }, "toolsets": { "nacos.config": "read" } }   // 可选：按工具集收紧级别
  ],
  "toolsets": {
    "sql.batch": { "enabled": false },
    "sql.tx":    { "enabled": true, "tools": { "dbx_commit_transaction": false } }
  },
  "providers": {
    "plugin:io.dbx.ssh": { "mcp": true, "ai": true, "ceiling": "write", "approvedTools": ["sftp_list_dir", "ssh_exec"] }
  },
  "runtime": { "queryTimeoutSecs": 0, "pluginToolsMode": "flat" }
}
```

- `rules[].toolsets` 是**收紧**规则（只能降级，不能升级），用来表达“这个连接整体读写，但 Salesforce 写入只读”这类例外。`allow_salesforce_dml` 的迁移就落在这里。
- 规则以目标为键做 upsert，避免同一个目标出现重复规则。

### 6.2 迁移

| v1 字段 | v2 |
|---|---|
| `read_only` / `allow_dangerous_sql` | `defaults.access` |
| `prompt_high_risk_sql` | `defaults.confirm = "full"`（false 时为 `"off"`） |
| `allowed_connection_ids` = None | `visibility.mode = all` |
| `allowed_connection_ids` / `allowed_group_ids` | `visibility.mode = selected` + 对应 rules 设 `visible: true` |
| `group_policies[]` | `rules[{group}]` |
| `connection_policies[]`（v1 版本标记） | `rules[{connection}]` |
| `connection_policies[]`（无版本标记的旧规则） | 按 `apply_ceiling` 计算出生效级别后写入，保持“只能收紧”的语义 |
| `database_scope` + `allowed_databases` | `scope` 规则的 `visible` |
| `database_policies[]` | `rules[{scope: database}]` |
| `allow_salesforce_dml = false` | `rules[{connection}].toolsets["salesforce.write"] = "read"` |
| `allowed_tool_names` | 反推出 `toolsets[*].enabled` 和单工具开关；插件通配符写到 `providers[*].mcp` |

**迁移验证**：在迁移函数旁边加一个属性测试：对任意 v1 策略、任意（连接、库、工具、SQL 级别）组合，v1 判定结果 == v2 判定结果。

### 6.3 独立二进制的版本差

桌面端保存时**同时写入**：

1. `mcp_policy_v2`：新格式，是权威数据。
2. `mcp_global_policy`（v1）：由 v2 **向下投影**得到，投影规则是“任何情况下都不比 v2 宽”。v1 表达不了的部分（例如按工具集收紧、新的 scope 种类）一律投影成更严的结果，例如直接关闭对应工具。

新版二进制优先读 v2；老版二进制只认识 v1，因此仍然安全。再过两到三个版本后，可以在升级检查里提示用户更新 `dbx-mcp`，然后停写 v1。

## 7. 确认与审计

- **确认通用化**：`McpSqlApprovalDialog` 推广为 `McpToolApprovalDialog`。弹窗展示：客户端、工具、目标资源、判定级别；SQL 额外展示语句和风险原因；插件工具额外展示参数摘要。任何提供方的工具，只要 `needs_confirm` 为真，就走这个弹窗。
- **桌面端不在线时（stdio 单独运行）**，需要确认的调用一律拒绝，并返回 `CONFIRMATION_UNAVAILABLE`，不会静默放行。
- **审计**：在现有历史记录基础上增加“MCP 调用记录”视图：时间、接入方式（stdio / HTTP）与客户端名称（取自 MCP initialize 上报的 clientInfo，仅用于记录，不参与权限判定）、工具、资源、级别、结果、是否经过确认。权限预览里可以从某个资源直接跳到它的调用记录。

## 8. 界面设计

### 8.1 信息架构

把现在的两个 Tab 调整为三个，每个 Tab 只回答一个问题：

```text
MCP Server  [可用]                                         [重新检查] [MCP 指南]

[ 接入 ]            [ 能力 ]              [ 访问控制 ]
 怎么连              能用哪些工具           能碰哪些资源、到什么程度
```

| Tab | 内容 | 相对现状的变化 |
|---|---|---|
| 接入 | stdio / HTTP、版本、安装卸载、客户端配置、运行参数（超时） | 插件工具对外提供方式移入能力的高级配置 |
| 能力 | 内置能力卡片 + 插件卡片，类似 uTools 插件列表，含高级配置 | 新增；取代现在“第 4 步”里平铺的 28 个勾选项 |
| 权限管理 | 全局默认权限 + 访问控制树（含生效预览）+ 独立调用安全 | 默认值和局部覆盖分开配置 |

### 8.2 能力 Tab

```text
搜索能力或工具…                                    [全部] [内置] [插件]  [仅显示已启用]

内置能力
┌─────────────────────────────────────────────────────────────────────────┐
│ [≡] SQL 查询           execute_query · execute_batch   读 写 高危   2/2  [●] │
│ [≡] 会话与事务          5 个工具                          读 写       5/5  [●] │
│ [≡] 对象结构            4 个工具                          读          4/4  [●] │
│ [≡] 消息队列            peek · send                      读 写       1/2  [●] │
│ [≡] Nacos             3 个工具集 · 2 个可用连接          读 写 高危   2/3  [●] │
│ [≡] Consul            3 个工具集 · 1 个可用连接          读 写 高危   2/3  [●] │
│     ……（每个按 §5 接入的产品自动生成一张卡片）                                  │
│ [≡] Salesforce        无可用连接                                    —    [○] │  ← 灰显
│ [≡] 工作台联动          2 个工具                          读          2/2  [●] │
│ [≡] 连接管理            3 个工具                          高危        0/3  [○] │
└─────────────────────────────────────────────────────────────────────────┘

插件
┌─────────────────────────────────────────────────────────────────────────┐
│ [🖥] Terminal  v1.4.0   io.dbx.ssh   6 个工具 · 3 个连接   读 写 高危  [●]  │
│      上限：读写    ⚠ 1 个新工具待确认                                       │
│ [☸] Kubernetes v0.3.1  作者未开放外部 MCP                           [—]   │
└─────────────────────────────────────────────────────────────────────────┘
```

- 级别徽标：读（中性色）/ 写（琥珀色）/ 高危（红色）。只表示“包含哪些级别的工具”，不是权限。
- 点击卡片打开右侧抽屉：工具列表（名称、说明、级别、适用连接类型、单工具开关）；插件还会显示授权上限选择、`内置 AI` / `外部 MCP` 两个开关和“预览工具”。
- 卡片开关就是工具集或插件的开关，单工具开关放在抽屉里，属于高级操作。

### 8.3 访问控制 Tab

```text
全局默认权限：[ 只读 ] [ 数据读写 ] [ 完全访问 ]
调用安全独立控制授权后高危调用的逐次确认，完全访问也遵循；权限不足直接拒绝。权限说明默认收起。

访问控制：连接可见范围 [全部连接 / 仅选中的]

搜索连接、分组、库…                                   [仅显示单独设置]
┌──────────────────────────────────┬──────┬──────────┬──────────┬──────────┐
│ 资源                               │ 可见  │ 访问级别   │ 确认      │ 生效      │
├──────────────────────────────────┼──────┼──────────┼──────────┼──────────┤
│ ▾ 📁 生产环境                       │ [✓]  │ 只读 ▾     │ 继承      │ 只读      │
│     ▸ 🐬 prod-mysql                 │ 继承  │ 继承       │ 继承      │ 只读 ·分组 │
│ ▾ 📁 开发                           │ [✓]  │ 继承       │ 继承      │ 只读 ·全局 │
│   ▾ 🐬 local-mysql-v8               │ 继承  │ 完全 ▾     │ 继承      │ 完全 ·连接 │
│       🗄 billing                    │ 继承  │ 只读 ▾     │ 继承      │ 只读 ·单库 │
│       + 添加库例外                   │      │          │          │          │
│     🧭 dev-nacos                    │ 继承  │ 读写 ▾     │ 写入以上   │ 读写 ·连接 │
│       🏷 namespace: public          │ 继承  │ 继承       │ 继承      │ 读写 ·连接 │
│     🖥 jump-host  (Terminal 插件)    │ 继承  │ 继承       │ 继承      │ 只读 ·全局 │
└──────────────────────────────────┴──────┴──────────┴──────────┴──────────┘
```

- **全局默认权限**用于没有更具体设置的资源；调整它只更新继承资源的生效预览，不改工具开关、连接范围或局部规则。
- **访问控制**为分组、连接和库设置具体权限；选择“继承”时使用上级设置。隐藏资源显示不可访问及其状态。
- 不再提供预设或“自定义”模式。调用安全使用独立可折叠区域；权限对照表默认收起为“权限说明”。
- **一棵树完成现在四步向导的全部工作**：可见性（原第 2 步）、子范围（原第 3 步）、级别（原第 1 和第 3 步）、生效预览（原第 4 步）。和侧边栏同构，用户不用在步骤之间来回切换。
- **子范围懒加载**：展开连接时才去请求库、namespace 等列表；默认只显示有例外的子范围，加上“+ 添加例外”入口，避免大实例一次展开几百个库。
- **“生效”列**显示最终级别和来源（全局 / 分组 / 连接 / 单库），等价于现在的“权限预览”。悬停时显示完整的继承链和硬保护（例如“连接已开启只读保护”）。
- 行内编辑后，在页面底部统一用“应用”保存，保留现有的保存交互。

### 8.4 交互上的简化点

- 权限管理包含全局默认权限、访问控制和独立调用安全；全局默认权限及分组、连接和库权限通过底部统一应用或放弃草稿。插件子范围沿用现有的即时保存提示。
- 客户端配置继续只包含启动参数，不包含任何权限信息，这一点和现在一致。
- 插件中心的插件详情页保留“AI 能力”一节，和 MCP 能力 Tab 编辑同一份数据，并互相提供跳转链接。

## 9. 分阶段落地

> P1 与原方案的差异（实现时调整，待评审）：
> - **子范围 `mcp.scope` 推迟到 P2**：它依赖 P2 的通用子范围规则，单独在 P1 落地没有判定入口。
> - **内置 AI 与外部 MCP 没有合并成一份存储**：内置 AI 继续用插件中心原有开关（`ai_plugin_tool_plugins`），外部 MCP 用新的 `plugin_mcp_grants`。两者的确认机制不同（内置 AI 每次调用确认，外部 MCP 靠授权上限），强行合并会改变内置 AI 的现有行为；插件中心改为显示外部 MCP 状态并指向设置页。
> - **插件工具暴露方式（flat / lazy）**：环境变量仍可强制覆盖，持久化策略和“能力 → 高级配置”提供 `flat|lazy|auto` 设置，新配置默认 `flat`。
> - **已确认工具记录了确认时的级别**：插件升级后，即使工具名不变、但声明级别升高（如读 → 写），也会重新进入待确认。
> - **插件的 MCP 工具标识**（2026-10-15 确认）：manifest 声明了 `mcp` 贡献（且有后端）即带"MCP 工具"标识；插件中心、商店卡片显示标识并可筛选，商店目录用 `mcpTools: true` 标出；只有带标识的插件出现在 MCP 能力页。需要插件方适配的内容以文档说明为准（`plugins/README.md`）。
> - **插件契约不兼容未适配的旧插件**（2026-10-15 确认）：外部 MCP 只认 manifest 显式声明的工具级别，不再按 MCP 标注推断；没保存过授权的插件不再沿用"作者开放即全部暴露"。插件需要按新契约适配。


| 阶段 | 内容 | 行为变化 | 主要改动 |
|---|---|---|---|
| **P0 工具描述符** ✅ 已实现并完成收尾 | 后端注册内置工具描述符表；新增 `mcp_tool_catalog` 接口；能力 Tab 按工具集展示（底层仍写 `allowed_tool_names`）；从驱动清单计算每个工具的覆盖范围，卡片和抽屉展示覆盖说明（§5.5.2）；能力页中没有适用连接的工具集仍可提前配置；客户端工具列表按连接覆盖情况裁剪；`tools/list` 对外说明追加覆盖范围，不支持的连接类型会列出可用工具 | 无（只是界面重组） | `mcp_catalog.rs`、`server.rs`、`McpCapabilitiesPanel.vue`、`McpPluginCapabilities.vue` |
| **P1 插件能力** ✅ 已实现 | manifest 新增 `toolsets` / `tools{toolset, access}`，`external_tools: true` 必须声明工具级别；外部 MCP 授权存储 `plugin_mcp_grants`（开关、授权上限、已确认工具及其级别、单工具关闭）；能力 Tab 插件卡片 + 首次授权弹窗 + 新增/升级工具待确认；插件中心显示外部 MCP 状态 | **严格契约**：未声明级别的工具永不暴露，未经用户授权的插件不暴露任何工具，声明级别覆盖 sidecar 自带标注 | `manifest.rs`、`plugin_mcp.rs`、`storage.rs`、`backend.rs`、`McpPluginCapabilities.vue` |
| **P2 策略 v2** ✅ 已实现并完成收尾 | ① 全局默认权限（原快速预设已按简化方案移除）；② v2 访问模型 `mcp_access.rs` + `decide()`；③ v1↔v2 映射与等价性 / "只会更严" / 精确往返测试；④ 存储 `mcp_access_policy`，v1/v2 同步写入，v1 保存不会抹掉 v2 独有的插件子范围规则；⑤ 访问控制树替换四步向导；⑥ 三端统一读取 v2 策略，WebBackend 不再回退到 v1；⑦ **通用确认**：声明为 `full` 的插件工具、高危 Redis 命令在"高危操作需确认"开启时弹窗一次性确认（桌面不在线一律拒绝），弹窗与 SQL 共用队列和失效机制；⑧ **插件子范围** `mcp.scope`：manifest 声明 kind/title/argument，服务端按 v2 规则校验调用参数里的值，访问控制树里可按连接编辑；⑨ 插件工具暴露方式持久化为 `pluginToolsMode: auto|flat|lazy`，环境变量优先，在“能力 → 高级配置”可设置，新配置默认 `flat`，保留已有模式；⑩ 插件 `scope.list_method` 提供桌面 Tauri / Web 读取值列表接口和复选编辑；⑪ 内置工具描述符向设置页传递 `resourceKinds` / `scopeKind` 元数据 | 判定输入来自 v2；新调用安全先授权再确认，不提升权限；旧 `confirm=full` 临时授权保留且明确标识 | `mcp_access.rs`、`storage.rs`、`approval.rs`、`mcp_bridge.rs`、`mcp_catalog.rs`、`McpSqlApprovalDialog.vue`、`McpPluginScopeEditor.vue`、`app_settings.rs` |
| **P3 产品能力接入** ✅ Nacos / Consul | 新增 `dbx-mcp/src/products.rs`（按产品分发到 `dbx-core/admin/<product>`）+ 服务端统一门 `run_product_tool`（工具白名单 → 连接类型 → v2 子范围准入与级别 → 连接只读 / 生产保护 → `full` 级走高危确认）。Nacos 14 个已接入工具（命名空间、配置搜索/读写删/历史/回滚、服务、实例注册/注销/上下线），`dbx_nacos_list_namespaces` 按连接的 `namespace` 子范围过滤；子范围 = namespace，访问控制树可按命名空间授权；Consul 8 个工具（KV 读写删带 CAS、服务、节点、健康、维护模式）。管理类（用户 / 角色 / ACL / 命名空间增删）、快照恢复、Raft 未开放。⏳ Redis / MQ / Salesforce 尚未迁到 `products.rs`（行为已符合规范：独立工具、声明级别、确认机制） | 新增能力；Nacos/Consul 在能力 Tab 自动出现工具集卡片 | `products.rs`、`server.rs`、`mcp_catalog.rs`、`McpAccessTree.vue` |
| **P4 审计** ✅ 已实现 | 调用记录本已存在（每次 MCP 调用写入历史，含工具、连接、耗时、请求/响应摘要、失败原因，历史面板有 MCP 视图和按工具筛选）。本期补充：① 记录发起调用的 **MCP 客户端名称和版本**、传输方式（stdio / HTTP）、声明访问级别及权限模式、确认状态（取自 MCP 调用生命周期，仅记录不参与判定），历史详情显示"MCP 客户端"；② 设置页接入方式中，与接入类型同一行右侧的"查看 MCP 调用记录"，一键打开历史面板并切到 MCP 视图（经设置页的关闭确认流程）；③ 访问控制树的连接和库节点可以直接打开已按资源过滤的 MCP 历史 | 新增 | `server.rs`（call_tool）、`QueryHistory.vue`、`mcpCallHistory.ts`、`McpAccessTree.vue` |

本轮按交接任务 T1→T8 完成收尾：补齐 Nacos 命名空间子范围过滤、只读资源下的静态写工具裁剪、覆盖范围说明和连接类型错误提示、插件工具暴露模式设置、能力页筛选、插件子范围值列表接口与复选编辑、授权文档重写及全部 13 种受支持语言文案。Rust 与前端验证均已执行；需要本地监听端口的既有测试在受限沙盒中会因 `Operation not permitted` 失败，详见 `tmp/codex-mcp-report.md`。

P0 和 P1 可以并行；P3 依赖 P2 的 scope 抽象，如果要提前上线某个产品的只读工具，也可以在 P2 之前用现有 `read_only` 判定先做一个只读版本。

## 10. 已确认的决策

| # | 事项 | 结论 |
|---|---|---|
| 1 | Tab 结构 | 三个 Tab：接入 / 能力 / 访问控制 |
| 2 | 四步向导 | 用访问控制树表替换 |
| 3 | 插件升级后新增或提升级别的工具 | 新增非只读工具、已确认工具升至更高的非只读级别都需重新确认；新增只读工具可在上限内自动可用；超过授权上限的工具始终隐藏 |
| 4 | 已开放外部 MCP 的现有插件 | 按 2026-10-15 确认的严格契约执行：必须声明工具级别并由用户授权，未保存授权时不暴露 |
| 5 | 非 SQL 产品的工具粒度 | 按产品区分，每个产品是独立提供方；Nacos / Consul 只是示例，所有现有和后续产品都按 §5 接入规范执行 |
| 6 | 客户端档案 | 不做。只维护 DBX 当前的一份全局权限策略，所有客户端共用 |
| 7 | SQL 类数据库 | 沿用现有通用工具，不按数据库拆分，行为不变；MongoDB 后续单独成产品（§5.5.1） |
| 8 | 通用工具的覆盖说明 | 界面分卡片摘要、覆盖详情、连接维度三层展示适用的数据库类型，数据从驱动清单计算（§5.5.2） |

### 调用安全语义与兼容

- `confirm=off`：按权限执行，不额外询问；权限不足直接拒绝。
- `confirm=high_risk`：先授权，再对高危调用逐次确认；完全访问也确认。无桌面确认、拒绝或超时不执行，批准后重新检查授权。
- `confirm=full`：仅为旧版兼容保留，Write 可临时授权部分 Full 操作，Full 不询问。旧 SQL 限时授权不能用于新策略。
- v1 的可选 `callConfirmation` 显式值优先于旧 `promptHighRiskSql`；标准化后新策略保存为 `high_risk` 且旧布尔值为 false。缺失新字段时保持原行为，v1/v2 往返和局部保存保留该语义。
- 设置页独立“调用安全”，旧模式默认展开说明；只有主动切换并应用才迁移。普通读取与普通写入不额外确认，高危判定由宿主目录/参数分类及插件声明决定。后续工具复用 `McpConfirmPolicy::decide`，先检查范围和硬保护，再询问、复核、执行。
