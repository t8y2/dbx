# DBX Rust 模块边界

## 依赖方向

`dbx-core` 是应用编排层，不再承载所有底层实现。桌面、Web、CLI、MCP
继续通过 core 调用连接、查询、导入导出等业务；独立工具可直接使用下层 crate。

```text
desktop / web / cli / mcp
            │
         dbx-core
            ├── dbx-drivers ── dbx-sql ── dbx-types
            │       ├── dbx-types
            │       ├── dbx-platform
            │       └── dbx-sqlite-worker (protocol, no runtime defaults)
            ├── dbx-plugin-runtime ── dbx-types + dbx-platform
            ├── dbx-ai-provider ── dbx-platform
            ├── dbx-formats
            ├── dbx-sql / dbx-types
            └── dbx-platform
```

下层 crate 不得反向依赖 core，包括 build 和 dev 依赖。涉及多层的测试放在
`dbx-core/tests/`，避免为了测试把数据库连接引入 SQL、类型或格式 crate。
`scripts/core-architecture.test.mjs` 校验 workspace 依赖、功能转发、源码归属、
构建输入和前端测试引用路径；CI 的 Rust 检查执行此守卫。

## 所有权

| Crate | 拥有的实现 | 不应引入 |
| --- | --- | --- |
| `dbx-types` | 连接配置、数据库身份、查询与元数据 DTO、JS 安全 JSON、MQTT/GridFS 数据记录 | 连接池、应用状态、驱动 SDK |
| `dbx-sql` | 解析、方言注册与加载、SQL 风险、DDL/DML、结构差异计划 | 查询执行、凭据、core 业务 |
| `dbx-drivers` | 原生驱动、隧道、JDBC/Agent 运行与分发、超时取消、SQLite 元数据读取 | 导入/迁移编排、应用配置持久化 |
| `dbx-formats` | CSV/XLSX/文本/时间格式与 ZIP 编码 | 数据库请求、连接管理 |
| `dbx-ai-provider` | 模型与 CLI 适配器、流式协议、事件和 token 用量 | 数据库工具执行和 Agent 业务循环 |
| `dbx-plugin-runtime` | manifest、签名与安装、Marketplace、子进程会话及 host 请求 | 数据库驱动实现、core 应用状态 |
| `dbx-platform` | 进程、路径、代理、下载、版本比较与共享用户提示网关 | 数据库身份和业务规则 |

`dbx-sql` 包含方言文件加载/监听，因此不是完全无 I/O 的函数库；边界是“不执行数据库业务”。
平台的 `host-prompts`、`downloads` 和类型库的 `mq-admin` 等能力显式启用，
避免只使用类型或纯格式的消费者意外加载驱动或应用层。

## Core 业务目录

```text
dbx-core/src/
  lib.rs          对外模块与旧 API 兼容导出
  connection/     连接路由、凭据、运行配置、JDBC 配置、任务监督
  query/          查询编排、取消、文档/Redis/HBase 操作、事务与对象缓存
  schema/         元数据编排、运行时 SQLite 表重建
  data/           导入导出、迁移、比较、备份、文档与脚本工作流
  ai/             数据库 Agent 循环、工具、解释、模板与 MCP 策略
  admin/          Nacos、Consul、MQ、MQTT
  persistence/    本地存储、历史、保存的 SQL、配置与云同步
  safety/         生产安全、写入解锁和风险指标
  host/           更新、变更日志和外部应用集成
  db/             驱动兼容导出与 Cloudflare D1 业务接口覆盖
```

目录内存放实际实现，不以 `#[path]` 把旧根目录伪装成新目录。已存在但未声明的
实验文件不会因迁移而自动启用。

Cloudflare D1 的批量导入依赖迁移逻辑，保留在 `data/cloudflare_d1/`；HTTP 驱动、
SQL 限制与词法处理位于 drivers。SQLite 表重建执行留在 core，SQL 生成位于 sql。
数据库查询驱动的 CSV 导出编排留在 core，CSV 编码位于 formats。

## 兼容性

- 原有 `dbx_core::models`、`dbx_core::types`、`dbx_core::db`、`dbx_core::sql*`、
  `dbx_core::ai`、`dbx_core::plugins` 及业务模块路径继续通过重导出可用。
- 同一 DTO、连接池、提示请求和插件类型不复制定义；旧路径与新 crate 具有相同类型身份。
  `public_api_compatibility` 测试覆盖这些跨层身份。
- 协议、序列化字段、默认配置、数据库语义、安装目录与进程生命周期不因搬迁而改变。
  原测试随实现迁移；依赖 core 的跨层测试移入 core 集成测试目录。
- `test-support` 仅提供原有 stub/测试钩子，由 dev-dependency 启用，不在生产依赖启用。
- 模块路径产生的日志 target 和 Rust 调试类型名会随 crate/目录变化。自定义
  `RUST_LOG=dbx_core=debug` 不会覆盖新 crate；需要加入
  `dbx_drivers=debug,dbx_sql=debug,dbx_plugin_runtime=debug,dbx_ai_provider=debug,dbx_platform=debug`
  等目标。默认桌面日志级别及 Web 默认过滤策略保持原样。

## Features 与资源

core 保留原来的 default feature 集合，并向实际实现 crate 转发
`duckdb-sidecar`、`dynamodb`、`mq-admin`、`openapi` 与 SQLite 能力。
`sqlite-bundled`、`sqlite-sqlcipher`、`sqlite-multiple-ciphers` 是不同的 SQLite
后端选择，不要用 workspace `--all-features` 代替合法组合测试。

- `dbx-types/build.rs` 消费 `plugins/connection-types/`。
- `dbx-sql/build.rs` 消费 `plugins/dialects/`。
- Pi MCP bridge 随 AI provider；Agent v2 协议 JSON 随 drivers，并与 Java resource 对照。
- 数据库文档导出的 JS/CSS 仍在 `dbx-core/assets/`，由 `pnpm build:docs-export` 生成。
- Docker 的依赖缓存阶段必须包含所有 workspace manifest 和 stub，实际构建阶段
  必须包含方言与连接类型目录。Nix 保留整个仓库源码输入。

## 验证

本机不启动数据库/引擎或 Docker 实例。单元测试包含内存 SQLite 与本地协议模拟器；
真实数据库验证复用 SSH 测试服务器上的专用测试实例，使用 SSH 隧道访问。
Linux 的文件权限回归测试应由非 root 用户执行；root 可绕过目录写权限，会让测试
前提失效。测试进程的代理应排除 localhost，避免本地 HTTP 模拟器请求被转发。

Rust 单元与集成测试使用 `cargo nextest run`，CI 固定 nextest `0.9.137`。
首次使用执行 `cargo install cargo-nextest --locked --version 0.9.137`。
文档测试仍单独使用 `cargo test --doc`；`make cargo-test-fast` 会依次运行 nextest
和文档测试，并保留跳过 DuckDB、启用 bundled SQLite 的本地验证配置。

```sh
pnpm test:architecture
cargo check -p dbx-core --no-default-features --all-targets

env -u DOCKER_CONTEXT \
  DOCKER_HOST=unix:///tmp/dbx-disabled-docker.sock \
  RUST_MIN_STACK=33554432 \
  cargo nextest run -p dbx-core -p dbx-drivers -p dbx-sql \
    -p dbx-types -p dbx-formats -p dbx-platform \
    -p dbx-ai-provider -p dbx-plugin-runtime \
    --no-default-features --features dbx-core/sqlite-bundled --lib --no-fail-fast

cargo nextest run -p dbx-core --no-default-features --features sqlite-bundled \
  --test public_api_compatibility --test connection_url_compatibility --no-fail-fast
```

交付验证还应覆盖桌面/Web/CLI/MCP 消费者、合法 feature 组合、前端类型与源码契约、
Agent 安装/恢复以及远程数据库查询/元数据/导入导出。`#[ignore]` 的 live 测试需要其
声明的测试环境变量；未运行的 live 用例不算通过。禁止把静态构建输入检查描述成
Docker/Nix 镜像已构建，也不能把单元测试通过描述成所有数据库版本均已实测。

拆分的直接收益是可独立检查的依赖边界、实现所有权与回归范围；编译时间、内存和
运行速度的提升需要同环境 benchmark，不能仅凭目录拆分推断。
