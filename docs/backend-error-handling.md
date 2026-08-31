# 后端异常处理与错误码规范

本文记录 DBX 当前已经落地的后端错误契约、恢复边界和前端展示规则。目标是让恢复逻辑依赖可验证的类型，让对外错误身份稳定，同时保留经过公共边界脱敏的数据库驱动诊断信息。

本文描述的是现有实现，不引入新的 Agent Protocol V3。结构化错误是 Agent Protocol v2 的可选 capability：`structured_error_v1`。

## 分层职责

1. Agent 只报告事实：`category`、`stage`、`operationOutcome`、`sessionDisposition` 以及 JDBC 诊断字段。
2. Rust `AgentCallError` 负责解码 Agent v2 的结构化错误；旧 Agent 或旧字符串接口只经过 `agent_driver` 中的兼容 adapter。
3. `RecoveryPolicy` 根据类型化错误和操作范围决定保留、隔离 Session 或替换 Runtime；它不从错误文本推断恢复动作。
4. `BackendError` catalog 将类型化错误映射为稳定的 `code`、`messageKey`、白名单参数和安全诊断字段。
5. 查询层通过 `QueryExecutionError::into_backend_error` 生成公共错误对象；Tauri、HTTP 和多语句结果只负责携带该对象，不重复分类。
6. 前端通过 `normalizeBackendError` 和 `translateBackendError` 生成本地化摘要，并在可用时追加服务端 `detail`。


## Agent 调用契约

Agent runtime 必须完成 Protocol v2 handshake，并支持 `multi_session`。如果声明 `structured_error_v1`，`call_typed` 在 RPC 失败时返回 `AgentCallError::Structured`；否则进入 `Legacy` 兼容路径。超时、取消、传输失败和契约不满足分别使用 `Timeout`、`Canceled`、`Transport` 和 `ContractViolation`。

业务代码应使用类型化入口：

```rust
let result = client.call_typed::<Response>(method, params, timeout, cancel).await;
if let Err(error) = &result {
    let decision = RecoveryPolicy::decide(error, RecoveryScope::UserOperation);
    // 只执行 Session/Runtime 恢复，不重放当前用户 SQL。
}
```

`AgentRuntimeClient::call` 和 `AgentCallError::into_legacy_string` 仅用于尚未迁移的字符串边界。旧字符串只有在 `try_agent_error_from_legacy` 能证明其来自 Agent 调用通道时才恢复为 Agent 错误；不要在 `query`、`schema`、`connection`、`keepalive` 或 UI 中增加新的文本分类规则。

## 公共错误对象

Rust `BackendError` 的字段由 catalog 构造，字段定义如下（JSON 使用 camelCase）：

```json
{
  "version": 1,
  "code": "DBX-JDBC-4001",
  "messageKey": "backendErrors.jdbc.sqlFailed",
  "messageParams": { "stage": "execute" },
  "source": "jdbcAgent",
  "origin": { "subsystem": "database", "adapter": "native" },
  "operationOutcome": "unknown",
  "detail": "relation missing_table does not exist",
  "diagnostics": {
    "category": "sql",
    "stage": "execute",
    "sqlState": "42P01",
    "vendorCode": 0,
    "exceptionClass": "java.sql.SQLException"
  }
}
```

约束：

- `version` 当前为 `1`。新增可选字段可以保持 v1；改变已有字段类型、必填性、语义或删除字段时必须升级版本。
- `code` 和 `messageKey` 发布后永久保留，不能复用或改义；废弃错误码只能停止新增使用，不能重新分配给其他含义。
- `source` 是 v1 兼容字段，表示旧的错误来源；新代码使用 `origin.subsystem` 和 `origin.adapter` 描述数据库、隧道、插件、AI、消息队列等子系统。客户端不能因为未知的 source/origin 值而丢弃整个 envelope。
- `origin` 是可扩展元数据，至少包含 `subsystem` 和 `adapter`，可选 `driver`；它不参与错误分类、恢复或重试决策。
- `diagnostics.adapterCode` 是适配器协议提供的可选错误码（例如 DuckDB worker 的 `duckdb_execute_failed`），仅用于诊断展示，不替代稳定的 DBX `code`。
- `operationOutcome` 只能是 `not_started` 或 `unknown`。结果未知时不能自动重放用户操作。
- `messageParams` 只能包含 catalog 声明的 string、number、boolean 标量，不得携带 SQL、URL、凭据或任意对象。
- Rust 字段保持私有，新增错误必须通过 catalog 构造，避免 code、key 和参数声明漂移。

## 错误码 catalog

| code | 含义 |
| --- | --- |
| `DBX-JDBC-1001` | 连接建立失败 |
| `DBX-JDBC-1002` | 已建立连接中断 |
| `DBX-JDBC-2001` | 操作超时且尚未开始 |
| `DBX-JDBC-2002` | 操作超时但结果未知 |
| `DBX-JDBC-2003` | 操作取消 |
| `DBX-JDBC-3001` | 资源繁忙，操作尚未开始 |
| `DBX-JDBC-3002` | Runtime 被替换 |
| `DBX-JDBC-4001` | 数据库 SQL 执行失败 |
| `DBX-JDBC-5001` | Agent 传输或协议失败 |
| `DBX-JDBC-5002` | Agent 错误上下文违反契约 |
| `DBX-JDBC-9001` | 旧 Agent 错误无法可靠分类 |
| `DBX-LEGACY-0001` | 非 Agent 或未迁移的字符串错误 |

新增错误码时：

1. 在 `crates/dbx-core/src/backend_error.rs` 的 catalog 中增加唯一 code、`messageKey` 和参数声明。
2. 为所有 locale 增加相同 key，并扩展 catalog 完整性测试。
3. 增加 Rust 映射和序列化测试，以及前端 normalize/翻译测试。
4. 若错误来自 Agent，先在 `AgentErrorContext` 中定义可验证的事实和合法组合，再添加 catalog 映射；不要用错误文本补分类。

## detail 与安全边界

`detail` 是数据库/驱动诊断的可选补充，不是分类依据。已类型化的 SQL 错误会保留数据库/驱动返回的原始正文；未知或连接类错误才使用 DBX 的凭据和 Session 清洗兜底：

- 最多保留 64 KiB 的 UTF-8 文本；超出部分按字符边界截断，空内容会被丢弃。
- 查询层需要补充上下文（例如说明 SQL 文本未随错误返回）时，使用独立换行符（`\n`）追加，不以空格拼接；消费者和测试应保留该换行边界。
- 数据库厂商错误正文（例如 `ERROR: relation ... does not exist`、`ORA-00942`、约束冲突中的值和驱动返回的 statement 文本）会原样保留；连接配置和未知错误文本中的 JDBC URL、密码、token、授权头、密钥和 Session 标识会被替换或在只剩敏感内容时删除。
- DBX 不解析、抽取或改写 SQL payload，也不会主动把执行 SQL 追加到错误；因此 SQL 方言、嵌套括号、引号和业务字面量不会被错误的通用字符串规则破坏。需要内部诊断时应单独记录原始请求，不得把内部日志对象直接复用为公共 envelope。
- `AgentErrorContext` 中的 `agentSessionId`、重试标记和内部恢复字段不会作为结构化字段进入公共 envelope；`connection` 等非 SQL 类别的驱动错误正文如果包含 Session 或凭据文本，公共 detail 仍会脱敏。
- Rust 查询执行器生成的查询超时会使用 `DBX-JDBC-2002`（阶段 `execute`）摘要，同时保留超时诊断 detail；它不会作为 `DBX-LEGACY-0001` 展示。
- PostgreSQL native driver 返回的标准服务端 `ERROR:` 诊断会使用 `DBX-JDBC-4001`（阶段 `execute`）摘要并保留原始 detail；连接、超时、取消和清理错误不使用该分类。
- DuckDB worker 返回的 `Parser Error`、`Catalog Error` 等厂商正文会保留在 `detail`；worker code 会放入 `diagnostics.adapterCode`，并在前端详情前显示。
- 超时和取消没有服务端 detail 时只返回摘要；`without_detail()` 只有在调用方明确要求隐藏 detail 时才会移除原文。

## 传输边界

### Tauri Desktop

查询命令将 `QueryExecutionError` 映射为 `BackendError`。单语句和事务查询即使通过 `execute_multi` 命令执行，`dbx-core` 也会在整个 multi-query 核心链路中保留 `QueryExecutionError`，直到 Tauri 边界才转换为 `BackendError`；不得先降级为字符串再重建 envelope。`apps/desktop/src/lib/backend/tauri.ts` 在查询失败时抛出 `BackendErrorException`，前端因此可以同时取得 `messageKey` 和原始 `detail`。Tauri 的连接、传输、导入和导出边界也统一将拒绝结果转换为 `BackendErrorException`；未知对象只提取有长度上限的 `message`、`reason` 或 `detail`，内容为空时使用稳定摘要。

### HTTP Web

`crates/dbx-web` 的 multi-query 路由也消费 typed 核心入口，并将 `AppError` 序列化为同一套 envelope；正常 HTTP 错误响应会保留按上述规则生成的 `detail`。`BackendError::without_detail()` 仅用于需要主动隐藏详情的兼容场景，不是默认响应路径。HTTP status 只表示传输结果，不能替代或改变 `BackendError.code`。

桌面端 HTTP 失败（包括 multipart、SSE、上传、下载和 Nacos 特殊接口）必须调用 `backendResponseError`，不能直接构造 `new Error(await response.text())`，否则会丢失 `BackendError v1` envelope。

### 多语句查询

`ExecuteMultiResult.error` 和进度事件中的 `error` 是权威的结构化错误字段，`execution_error` 表示该结果确实失败。已经进入 typed 通用逐语句路径的错误必须直接从 `QueryExecutionError` 生成该字段，不能从兼容字符串反向推断。MySQL 和 SQL Server 的专用 batch executor 当前仍是字符串驱动边界，只有在驱动层提供可验证的 typed failure facts 后才能迁移，不能在 query/UI 层按错误正文补分类。旧的 `Error` 行仅用于兼容；真实查询结果中名为 `Error` 的普通列不能被当作失败。

## 前端展示规则

`normalizeBackendError` 只接受完整且类型正确的 envelope；`detail` 如果存在必须是 string，兼容 fallback 的单次上限为 64 KiB。解析嵌套的 `{ error }`、`{ backendError }`、`BackendErrorException` 和跨 realm 的 Error-like 对象时使用有限深度和循环检测；无法识别的对象只保留有界的 `message`、`reason` 或 `detail` 文本，空对象使用稳定摘要。`translateBackendError` 的结构化路径为：

1. 使用 `messageKey` 和 `messageParams` 生成当前 locale 的自定义摘要。
2. 若 `detail` 非空且不同于摘要，在摘要后追加空行和 detail。
3. 无法识别的旧字符串继续原样展示或按兼容 pattern 翻译。

catch 到异常时必须把原始对象传给翻译器：

```ts
translateBackendError(t, error)
```

不要先执行 `error.message || String(error)`，否则会丢失 `messageKey`、参数和服务端 detail。旧版非 i18n 页面可以使用 `formatError`，但绝不能把结构化 envelope 直接转换成 `[object Object]`。

## 协议演进与兼容规则

- `version` 表示 envelope 版本，不表示 Agent Protocol 版本。未知的大版本不能按旧字段强行解析；客户端应保留安全 fallback，并记录原始版本用于诊断。
- 新增可选字段属于向后兼容变更；改变字段类型、必填性、枚举语义、错误码含义或安全边界时，必须发布新版本并保留旧版本适配器。
- 客户端应忽略未知的可选字段和未知的 `source`/`origin` 枚举值，但仍严格校验 `version`、`code`、`messageKey`、`messageParams`、`operationOutcome` 和 `detail` 的基本类型。
- `code` 是稳定机器标识，不能复用；`messageKey` 是稳定本地化标识，文案可以调整，但 key 的语义不能改变。错误码废弃时保留旧 locale 和兼容映射。
- 结构化 envelope 可生成本地化摘要并追加按错误来源处理的 `detail`；旧字符串或 malformed object 使用有界文本 fallback；空响应只显示稳定摘要，不伪造数据库原因。
- `operationOutcome=unknown` 不能因为 fallback 文本、source、origin 或 detail 推断为可重试；恢复决策只依赖 Rust 中的类型化事实。

兼容代码的退役门槛包括：不再存在直接读取 HTTP 响应文本并抛错的路径；迁移后的后端错误展示调用点不再在 `translateBackendError` 前预先提取 `.message`/`String(error)`；在所有消费者接受 `BackendError v1` 且线协议测试通过前，不移除旧字符串或旧版错误行。

## 恢复规则

- `operationOutcome=unknown`：禁止自动重放 SQL、写入、DDL、事务和批处理。
- 用户操作：即使 Agent 声明可重试，也只做 Session/Runtime 恢复并向用户返回原错误。
- 只读 metadata：只有 connection + quarantine 场景可以新建 Session 重试，最多一次。
- `replace_runtime`：移除共享同一 Runtime 的路由；最终决定权在 Rust，不在 Agent 或前端。
- contract violation、timeout、cancel：至少隔离当前 Session；旧 Session 的迟到结果不得影响新的路由代际。

## 提交前检查

```text
cargo fmt --all -- --check
cargo clippy -j 1 -p dbx-core --no-default-features --all-targets -- -D warnings
cargo test -j 1 -p dbx-core --no-default-features --lib backend_error::tests
cargo test -j 1 -p dbx-core --no-default-features --lib agent_recovery::tests
cargo check -j 1 -p dbx-web --no-default-features
pnpm typecheck
pnpm vitest run apps/desktop/src/i18n/__tests__/backendErrors.spec.ts
```
