# DBX MCP Server

Rust-powered Model Context Protocol server for [DBX](https://github.com/t8y2/dbx). It lets MCP-compatible AI agents inspect schemas and run safe database operations using connections configured in DBX.

[中文说明](#中文说明) | [npm](https://www.npmjs.com/package/@dbx-app/mcp-server) | [Native releases](https://github.com/t8y2/dbx/releases?q=packages-v)

## Architecture

```text
@dbx-app/mcp-server
└── small Node.js launcher
    └── platform-specific Rust dbx-mcp binary
        └── dbx-core database and agent infrastructure
```

The MCP protocol, connection loading, SQL safety, schema access, Redis support, MongoDB shell parsing, Web backend access, and database execution are implemented in Rust. Node.js is used only by the npm launcher so existing `npm`, `npx`, and MCP client configurations continue to work.

## Features

- **10 MCP tools** for connections, schemas, SQL, Redis, and DBX UI integration
- **Precompiled native binaries** with no local Rust, Cargo, Python, or C/C++ build requirement
- **No `better-sqlite3` runtime dependency** and no Node native-addon ABI coupling
- **Local, Web, and Docker modes** using the same tool interface
- **Direct native execution** for supported SQL, Redis, and MongoDB connections
- **Agent/JDBC database support** through DBX agent infrastructure when the required agent and JRE are installed
- **DBX-managed access policy** with a connection allowlist and three execution modes
- **SQL, Redis, and MongoDB safety controls** that reload the policy for every request
- **Offline execution** through downloadable native binaries
- **Optional desktop integration** for opening tables and displaying query results in DBX

## Installation

### npm global install

```bash
npm install -g @dbx-app/mcp-server
```

Then configure the MCP client to run:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server"
    }
  }
}
```

### npx

No global installation is required:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "npx",
      "args": ["-y", "@dbx-app/mcp-server"]
    }
  }
}
```

The npm package automatically installs the native package matching the current operating system and CPU. Do not install with `--no-optional`, because npm optional dependencies carry the platform binary.

### Native binary / offline install

Every package release publishes native archives and `SHA256SUMS` in [GitHub Releases](https://github.com/t8y2/dbx/releases?q=packages-v):

| Platform | Release asset | npm platform package |
| --- | --- | --- |
| macOS Apple Silicon | `dbx-mcp-darwin-arm64.tar.gz` | `@dbx-app/mcp-darwin-arm64` |
| macOS Intel | `dbx-mcp-darwin-x64.tar.gz` | `@dbx-app/mcp-darwin-x64` |
| Linux glibc ARM64 | `dbx-mcp-linux-arm64-gnu.tar.gz` | `@dbx-app/mcp-linux-arm64-gnu` |
| Linux glibc x64 | `dbx-mcp-linux-x64-gnu.tar.gz` | `@dbx-app/mcp-linux-x64-gnu` |
| Windows ARM64 | `dbx-mcp-win32-arm64.zip` | `@dbx-app/mcp-win32-arm64` |
| Windows x64 | `dbx-mcp-win32-x64.zip` | `@dbx-app/mcp-win32-x64` |

Verify a Unix archive before extracting it:

```bash
sha256sum --check SHA256SUMS
tar -xzf dbx-mcp-linux-x64-gnu.tar.gz
chmod +x dbx-mcp
```

On macOS, use `shasum -a 256` if `sha256sum` is unavailable. On Windows, use `certutil -hashfile <archive> SHA256` and compare the value with `SHA256SUMS`.

Configure the MCP client to run the extracted file directly:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "/absolute/path/to/dbx-mcp"
    }
  }
}
```

Direct native execution does not require Node.js. GitHub package releases are intentionally not marked as the repository's latest release, so they do not replace the latest DBX desktop release.

## Requirements

### npm installation

- Node.js 18.18.0 or newer
- A supported operating system and CPU from the platform table
- npm optional dependencies enabled

### Native installation

- No Node.js or npm requirement
- Linux builds currently require glibc; Alpine/musl is not supported yet

### Database configuration

DBX MCP reads connection profiles from DBX storage. DBX does not need to remain open for native connections. However:

- the connection must already exist in DBX storage, unless it is added through `dbx_add_connection`;
- DBX Agent/JDBC databases require the matching agent, JDBC driver, and JRE to be installed;
- `dbx_open_table` and `dbx_execute_and_show` require a running DBX desktop application;
- DBX Web mode requires a reachable DBX Web server.

## Usage Examples

Ask the MCP client to:

- "List my DBX connections"
- "Show tables in the production PostgreSQL connection"
- "Describe the `orders` table"
- "Build schema context for the billing database"
- "Count orders created in the last seven days"
- "Run `INFO memory` on the Redis connection"
- "Find the latest MongoDB documents in the events collection"
- "Open the orders table in DBX"

## Tools

| Tool | Description |
| --- | --- |
| `dbx_list_connections` | List connections visible to the MCP session |
| `dbx_add_connection` | Add a connection to DBX storage |
| `dbx_remove_connection` | Remove a connection from DBX storage |
| `dbx_list_tables` | List tables, views, or collections |
| `dbx_describe_table` | Return columns and table metadata |
| `dbx_get_schema_context` | Return compact schema context suitable for an AI model |
| `dbx_execute_query` | Execute SQL or a supported MongoDB shell command, returning at most 100 rows |
| `dbx_execute_redis_command` | Execute a Redis command |
| `dbx_open_table` | Open a table in the running DBX desktop application |
| `dbx_execute_and_show` | Execute a query and display the result in the DBX desktop application |

When connection scoping is enabled, mutating connection tools and desktop UI tools are hidden.

## Execution Modes

### Local native mode

This is the default. MCP reads DBX connection storage and executes supported connections locally in the Rust process.

Common native paths include PostgreSQL, MySQL, SQLite, compatible SQL databases, Redis standalone, and MongoDB. SSH, cluster, vendor-specific, or Agent/JDBC connections may require additional DBX infrastructure.

DBX connection storage defaults to:

- macOS: `~/Library/Application Support/com.dbx.app/dbx.db`
- Linux: `~/.local/share/com.dbx.app/dbx.db`
- Windows: `%APPDATA%\com.dbx.app\dbx.db`

Override the directory with `DBX_DATA_DIR`.

### Agent/JDBC databases

Databases such as Dameng, Kingbase, Oracle, DB2, Hive, Trino, Snowflake, SAP HANA, and other DBX Agent profiles use DBX's Java agent infrastructure rather than a Node.js database driver.

The native npm/GitHub binary does not bundle every proprietary JDBC driver or JRE. Install the database agent through DBX first, or provide a compatible agent installation under the DBX agent directory. Availability depends on the installed driver and license terms of the database vendor.

### DBX Web / Docker mode

Set `DBX_WEB_URL` to use a deployed DBX Web backend instead of local desktop storage:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server",
      "env": {
        "DBX_WEB_URL": "https://dbx.example.com",
        "DBX_WEB_PASSWORD": "your-web-login-password"
      }
    }
  }
}
```

`DBX_WEB_PASSWORD` is the password used on the DBX Web login page. Desktop-local mode does not use it. Desktop UI tools are hidden in Web mode.

### Windows portable DBX

Point `DBX_DATA_DIR` at the portable `data` directory containing `dbx.db`:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server",
      "env": {
        "DBX_DATA_DIR": "D:\\DBX_x64-portable\\data"
      }
    }
  }
}
```

## DBX-managed MCP Policy

DBX stores one authoritative policy under **Settings → MCP** and reloads it for every request:

| Permission mode | Allowed operations |
| --- | --- |
| Read only | Queries and metadata reads |
| Data read/write | Regular inserts, effectively filtered updates/deletes, scoped MongoDB mutations, and ordinary Redis writes |
| Full access | Also permits broad updates/deletes, DDL, `TRUNCATE`, MongoDB destructive operations, and Redis `FLUSH*` |

**Allowed connections** controls which stable connection IDs MCP can list or resolve. Connection-level read-only protection, production protection, database credentials, and the allowlist remain upper bounds in every mode.

Conditions such as `WHERE TRUE`, `WHERE 1 = 1`, `_id: {$exists: true}`, complementary predicates, and opaque MongoDB filters remain high risk. Unknown Redis commands also fail closed.

Legacy connection scope variables can still narrow the DBX allowlist for existing client configurations:

```json
{
  "mcpServers": {
    "dbx-production-scope": {
      "command": "dbx-mcp-server",
      "env": {
        "DBX_MCP_SCOPE_CONNECTION_NAME": "production-postgres",
        "DBX_MCP_SCOPE_DATABASE": "analytics"
      }
    }
  }
}
```

Use `DBX_MCP_SCOPE_CONNECTION_ID`, comma-separated `DBX_MCP_SCOPE_CONNECTION_IDS`, or `DBX_MCP_SCOPE_CONNECTION_NAME`. ID scopes take precedence over the name scope. The scoped database is optional.

## Safety

Choose **Read only**, **Data read/write**, or **Full access** in DBX instead of placing permission flags in client configuration. Updated servers do not let `DBX_MCP_ALLOW_WRITES` or `DBX_MCP_ALLOW_DANGEROUS_SQL` widen the DBX policy. For upgrade compatibility, `DBX_MCP_ALLOW_WRITES=0` (or `false`) keeps MCP read-only until a central policy is saved for the first time; the legacy permission variables are ignored afterward.

MongoDB update/delete operations require a verifiably effective filter unless Full access is enabled. Aggregation stages such as `$out` and `$merge` are treated as high-risk writes.

SQL text is not included in normal MCP errors or logged by default. Enable temporary diagnostics with `DBX_MCP_DEBUG_SQL=1` and disable it after troubleshooting.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `DBX_DATA_DIR` | Override the local DBX data directory |
| `DBX_WEB_URL` | Use a DBX Web/Docker backend |
| `DBX_WEB_PASSWORD` | Authenticate to the DBX Web backend |
| `DBX_MCP_ALLOW_WRITES` | Upgrade compatibility only: `0`/`false` keeps an unconfigured policy read-only |
| `DBX_MCP_SCOPE_CONNECTION_ID` | Compatibility scope for one connection ID |
| `DBX_MCP_SCOPE_CONNECTION_IDS` | Compatibility scope for multiple connection IDs |
| `DBX_MCP_SCOPE_CONNECTION_NAME` | Restrict tools to one connection name |
| `DBX_MCP_SCOPE_DATABASE` | Restrict tools to one database |
| `DBX_MCP_DEBUG_SQL` | Include SQL in temporary diagnostics |
| `DBX_MCP_BINARY` | Override the native binary used by the npm launcher |

## Troubleshooting

### Optional platform package was not installed

Reinstall without `--no-optional`:

```bash
npm uninstall -g @dbx-app/mcp-server
npm install -g @dbx-app/mcp-server@latest
```

Verify the current Node platform:

```bash
node -p 'process.platform + "-" + process.arch'
```

### Unsupported Linux distribution

The published Linux packages target glibc. Alpine Linux uses musl by default and is not currently supported.

### `dbx.db` cannot be found

Set `DBX_DATA_DIR` to the directory containing `dbx.db`, not to the database file itself.

### Desktop action says DBX is not running

Database queries can run without the desktop application when the connection is supported locally. `dbx_open_table` and `dbx_execute_and_show` intentionally require DBX desktop to be running.

### Agent/JDBC database cannot start

Open DBX Driver Manager and install/update the matching database agent and JRE. The standalone MCP binary does not redistribute every proprietary JDBC driver.

### `better-sqlite3` or Node ABI error

The Rust MCP runtime does not depend on `better-sqlite3`. This error normally indicates an older MCP version or the separate TypeScript-based `@dbx-app/cli` package. Upgrade MCP with:

```bash
npm install -g @dbx-app/mcp-server@latest
```

## Development

Run the Rust server from source:

```bash
cargo run -p dbx-mcp --no-default-features
```

Run tests:

```bash
cargo test -p dbx-mcp --no-default-features
pnpm --filter @dbx-app/mcp-server test
```

Build a release binary:

```bash
cargo build --release -p dbx-mcp --no-default-features
```

## DBX CLI

`@dbx-app/cli` is a separate terminal-oriented package and currently remains TypeScript/Node.js based:

```bash
npm install -g @dbx-app/cli
dbx connections list --json
dbx query local "select 1" --json
```

See the [CLI README](../cli/README.md).

## License

Apache-2.0

---

## 中文说明

DBX MCP Server 是 [DBX](https://github.com/t8y2/dbx) 的 Rust MCP 服务，让 Claude Code、Cursor、Windsurf 等兼容 MCP 的 AI 工具使用 DBX 中已有的连接查询数据库。

[npm](https://www.npmjs.com/package/@dbx-app/mcp-server) | [原生版本下载](https://github.com/t8y2/dbx/releases?q=packages-v)

### 架构

```text
@dbx-app/mcp-server
└── 轻量 Node.js 启动器
    └── 当前平台的 Rust dbx-mcp 二进制
        └── dbx-core 数据库和 Agent 基础设施
```

MCP 协议、连接读取、SQL 安全检查、Schema、Redis、MongoDB、Web 后端和数据库执行均由 Rust 实现。Node.js 只用于保持原有 npm/npx 安装入口不变。

### 主要能力

- 10 个 MCP 工具
- 不依赖 `better-sqlite3`，没有 Node 原生模块 ABI 问题
- 支持本地 DBX、DBX Web 和 Docker
- 支持预编译原生二进制和离线运行
- 支持常见 SQL、Redis、MongoDB 直连
- 支持达梦、金仓、Oracle、DB2、Hive 等 Agent/JDBC 数据库
- 支持只读、危险操作、连接和数据库作用域限制
- DBX 桌面端未启动时仍可执行支持本地运行的连接

### npm 安装

```bash
npm install -g @dbx-app/mcp-server
```

MCP 配置：

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server"
    }
  }
}
```

也可以直接使用 npx：

```json
{
  "mcpServers": {
    "dbx": {
      "command": "npx",
      "args": ["-y", "@dbx-app/mcp-server"]
    }
  }
}
```

不要使用 `--no-optional`，平台二进制通过 npm `optionalDependencies` 自动安装。

### 原生二进制和离线安装

每个 packages 版本会在 [GitHub Releases](https://github.com/t8y2/dbx/releases?q=packages-v) 发布以下文件：

| 平台 | 文件 |
| --- | --- |
| macOS Apple Silicon | `dbx-mcp-darwin-arm64.tar.gz` |
| macOS Intel | `dbx-mcp-darwin-x64.tar.gz` |
| Linux glibc ARM64 | `dbx-mcp-linux-arm64-gnu.tar.gz` |
| Linux glibc x64 | `dbx-mcp-linux-x64-gnu.tar.gz` |
| Windows ARM64 | `dbx-mcp-win32-arm64.zip` |
| Windows x64 | `dbx-mcp-win32-x64.zip` |

下载后使用 `SHA256SUMS` 校验，并直接配置：

```json
{
  "mcpServers": {
    "dbx": {
      "command": "/绝对路径/dbx-mcp"
    }
  }
}
```

直接运行原生文件不需要 Node.js。Linux 当前只支持 glibc，暂不支持 Alpine/musl。

### 系统要求

- npm 安装需要 Node.js 18.18.0 或更高版本
- 原生二进制不需要 Node.js、Rust、Cargo、Python 或本地编译环境
- 连接配置需要存在于 DBX 存储中，或通过 `dbx_add_connection` 添加
- Agent/JDBC 数据库需要提前安装对应 Agent、JDBC Driver 和 JRE
- `dbx_open_table`、`dbx_execute_and_show` 需要 DBX 桌面端正在运行

### 工具列表

| 工具 | 说明 |
| --- | --- |
| `dbx_list_connections` | 列出当前 MCP 会话可见的连接 |
| `dbx_add_connection` | 添加 DBX 连接配置 |
| `dbx_remove_connection` | 删除 DBX 连接配置 |
| `dbx_list_tables` | 列出表、视图或集合 |
| `dbx_describe_table` | 获取字段和表结构 |
| `dbx_get_schema_context` | 获取适合 AI 使用的紧凑 Schema 上下文 |
| `dbx_execute_query` | 执行 SQL 或支持的 MongoDB Shell 命令，最多返回 100 行 |
| `dbx_execute_redis_command` | 执行 Redis 命令 |
| `dbx_open_table` | 在 DBX 桌面端打开表 |
| `dbx_execute_and_show` | 执行查询并在 DBX 桌面端展示结果 |

### 本地数据目录

- macOS：`~/Library/Application Support/com.dbx.app/dbx.db`
- Linux：`~/.local/share/com.dbx.app/dbx.db`
- Windows：`%APPDATA%\com.dbx.app\dbx.db`

通过 `DBX_DATA_DIR` 覆盖默认目录。Windows 便携版应指向 `DBX.exe` 同级、包含 `dbx.db` 的 `data` 文件夹。

### DBX Web / Docker

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server",
      "env": {
        "DBX_WEB_URL": "https://dbx.example.com",
        "DBX_WEB_PASSWORD": "Web 登录密码"
      }
    }
  }
}
```

Web 模式不会读取本机 DBX 桌面存储，也不会暴露桌面 UI 工具。

### Agent/JDBC 数据库

达梦、人大金仓、Oracle、DB2、Hive、Trino、Snowflake、SAP HANA 等数据库通过 DBX Java Agent/JDBC 基础设施运行，而不是通过 Node.js 数据库驱动运行。

npm 和 GitHub Release 中的原生 MCP 文件不会捆绑所有厂商的专有 JDBC Driver。请先通过 DBX Driver Manager 安装对应 Agent 和 JRE，或提供兼容的 DBX Agent 目录。

### DBX 管理的 MCP 策略

DBX 在 **设置 → MCP** 中保存一份权威策略，并在每次请求时重新读取：

| 权限模式 | 允许的操作 |
| --- | --- |
| 只读 | 查询和元数据读取 |
| 数据读写 | 普通插入、带有效过滤条件的更新/删除、范围明确的 MongoDB 修改和普通 Redis 写入 |
| 完全访问 | 额外允许大范围更新/删除、DDL、`TRUNCATE`、MongoDB 破坏性操作和 Redis `FLUSH*` |

**允许访问的连接** 决定 MCP 可以列出和解析哪些稳定连接 ID。连接自身只读、生产库保护、数据库账号权限和 allowlist 在任何模式下都是权限上限。

`WHERE TRUE`、`WHERE 1 = 1`、`_id: {$exists: true}`、互补条件或不透明 MongoDB 过滤器仍按高风险处理。未知 Redis 命令也会失败关闭。

旧连接 scope 变量可继续兼容读取，但只能进一步收窄 DBX allowlist：

```json
{
  "mcpServers": {
    "dbx-production-scope": {
      "command": "dbx-mcp-server",
      "env": {
        "DBX_MCP_SCOPE_CONNECTION_NAME": "production-postgres",
        "DBX_MCP_SCOPE_DATABASE": "analytics"
      }
    }
  }
}
```

可使用 `DBX_MCP_SCOPE_CONNECTION_ID`、逗号分隔的 `DBX_MCP_SCOPE_CONNECTION_IDS` 或 `DBX_MCP_SCOPE_CONNECTION_NAME`。ID scope 优先于名称 scope；作用域模式会隐藏连接增删和桌面 UI 工具。

### SQL 和命令安全

请在 DBX 中选择 **只读**、**数据读写** 或 **完全访问**，不要在客户端配置中放置权限开关。新版 Server 不允许 `DBX_MCP_ALLOW_WRITES` 或 `DBX_MCP_ALLOW_DANGEROUS_SQL` 放宽 DBX 中央策略。为兼容升级，在中央策略首次保存前，`DBX_MCP_ALLOW_WRITES=0`（或 `false`）仍会保持 MCP 只读；策略保存后旧权限变量即被忽略。

MongoDB 更新和删除在未启用完全访问时必须提供可验证有效的 filter；`$out`、`$merge` 聚合阶段按高风险写操作处理。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `DBX_DATA_DIR` | 覆盖本地 DBX 数据目录 |
| `DBX_WEB_URL` | 使用 DBX Web/Docker 后端 |
| `DBX_WEB_PASSWORD` | DBX Web 登录密码 |
| `DBX_MCP_ALLOW_WRITES` | 仅用于升级兼容：`0`/`false` 使尚未配置的策略保持只读 |
| `DBX_MCP_SCOPE_CONNECTION_ID` | 兼容旧配置：限制到指定连接 ID |
| `DBX_MCP_SCOPE_CONNECTION_IDS` | 兼容旧配置：限制到多个连接 ID |
| `DBX_MCP_SCOPE_CONNECTION_NAME` | 限制到指定连接名称 |
| `DBX_MCP_SCOPE_DATABASE` | 限制到指定数据库 |
| `DBX_MCP_DEBUG_SQL` | 临时输出 SQL 诊断信息 |
| `DBX_MCP_BINARY` | 覆盖 npm 启动器使用的原生文件 |

### 常见问题

**提示平台 optional package 未安装**

重新安装并确保没有使用 `--no-optional`：

```bash
npm uninstall -g @dbx-app/mcp-server
npm install -g @dbx-app/mcp-server@latest
```

**提示找不到 `dbx.db`**

将 `DBX_DATA_DIR` 设置为包含 `dbx.db` 的目录，而不是数据库文件路径。

**提示 DBX 未运行**

普通数据库查询不一定需要启动 DBX；只有桌面 UI 工具和仍需 bridge 的连接需要 DBX 运行。

**Agent 数据库无法启动**

通过 DBX Driver Manager 安装或更新对应数据库 Agent、JDBC Driver 和 JRE。

**出现 `better-sqlite3` 或 Node ABI 错误**

Rust MCP 不依赖 `better-sqlite3`。请升级 MCP；如果错误来自 `@dbx-app/cli`，则属于当前仍为 TypeScript 的独立 CLI 包。

### 开发和测试

```bash
cargo run -p dbx-mcp --no-default-features
cargo test -p dbx-mcp --no-default-features
pnpm --filter @dbx-app/mcp-server test
cargo build --release -p dbx-mcp --no-default-features
```

### DBX CLI

`@dbx-app/cli` 是独立的终端包，目前仍使用 TypeScript/Node.js：

```bash
npm install -g @dbx-app/cli
dbx connections list --json
```

详见 [CLI README](../cli/README.md)。

### License

Apache-2.0
