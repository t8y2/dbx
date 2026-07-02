# DBX MCP Server

MCP server for [DBX](https://github.com/t8y2/dbx) — lets AI agents (Claude Code, Cursor, etc.) query your databases using connections already configured in DBX.

[中文](#中文说明) | English

## Features

- **Zero config** — Automatically reads your DBX connections (including passwords from system keyring)
- **9 tools** — List/add/remove connections, list tables, describe table, get schema context, execute SQL, execute Redis commands, open table in DBX UI
- **Connection pooling** — Reuses database connections across queries
- **Direct execution** — PostgreSQL, MySQL, SQLite, and compatible databases (Doris, StarRocks, etc.) can run without opening DBX
- **Writes enabled by default** — regular `INSERT` / `UPDATE` / `DELETE` statements work out of the box, while dangerous SQL stays blocked unless explicitly enabled
- **DBX UI integration** — Open tables directly in the DBX desktop app from your AI agent

## Quick Start

### 1. Install

```bash
npm install -g @dbx-app/mcp-server
```

Or run directly:

```bash
npx @dbx-app/mcp-server
```

### 2. Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server"
    }
  }
}
```

For Windows portable builds, set `DBX_DATA_DIR` to the portable data directory that contains `dbx.db`:

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

Or for development (from source):

```json
{
  "mcpServers": {
    "dbx": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/index.ts"],
      "cwd": "/path/to/dbx"
    }
  }
}
```

### 3. Use

In Claude Code, just ask:

- "List my database connections"
- "Show the tables in my local-pg connection"
- "Describe the users table"
- "Query the average salary from employees"
- "Open the orders table in DBX"

## CLI

For terminal, script, and Codex workflows, install the dedicated CLI package:

```bash
npm install -g @dbx-app/cli
dbx connections list --json
dbx query local "select 1" --json
```

See the [DBX CLI README](../cli/README.md) for command details.

## Tools

| Tool                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `dbx_list_connections`      | List all database connections configured in DBX      |
| `dbx_add_connection`        | Add a new database connection                        |
| `dbx_remove_connection`     | Remove a database connection                         |
| `dbx_list_tables`           | List tables and views for a connection               |
| `dbx_describe_table`        | Get column definitions for a table                   |
| `dbx_get_schema_context`    | Get compact table and column context for writing SQL |
| `dbx_execute_query`         | Execute a SQL query (max 100 rows)                   |
| `dbx_execute_redis_command` | Execute a Redis command on a Redis connection        |
| `dbx_open_table`            | Open a table in DBX desktop app UI                   |

## SQL Safety

`dbx_execute_query` accepts multiple SQL statements and executes them one at a time after checking each statement. Regular write statements such as `INSERT`, `UPDATE`, and `DELETE ... WHERE ...` are allowed by default.

If you need to force a read-only MCP session, set:

```bash
DBX_MCP_ALLOW_WRITES=0
```

Dangerous statements such as `DROP`, `TRUNCATE`, and `ALTER` remain blocked unless you also set:

```bash
DBX_MCP_ALLOW_DANGEROUS_SQL=1
```

Redis connections use `dbx_execute_redis_command` instead of `dbx_execute_query`. Redis write commands honor `DBX_MCP_ALLOW_WRITES`; dangerous Redis commands such as `KEYS`, `FLUSHALL`, and `EVAL` require `DBX_MCP_ALLOW_DANGEROUS_SQL=1`.

## How It Works

```
AI Agent → MCP Server → Database
                ↓
         DBX SQLite database (dbx.db)
```

The MCP server reads your database connections from DBX's SQLite database:

- **macOS**: `~/Library/Application Support/com.dbx.app/dbx.db`
- **Linux**: `~/.local/share/com.dbx.app/dbx.db`
- **Windows**: `%APPDATA%\com.dbx.app\dbx.db`

Windows portable builds store data next to `DBX.exe`, usually in `data\dbx.db`. Set `DBX_DATA_DIR` to that `data` folder instead of copying `dbx.db` into the default directory.

## DBX UI Integration

The `dbx_open_table` tool communicates with the running DBX app to open tables directly in the UI. This requires DBX to be running. If DBX is not running, the tool will return an error message.

PostgreSQL, MySQL, SQLite, Doris, StarRocks, and Redshift queries run directly from the MCP server. Redis standalone command execution also runs directly. Other database types, plus Redis Sentinel/Cluster or SSH-backed Redis connections, still use the DBX desktop bridge unless `DBX_WEB_URL` is configured.

## Requirements

- [DBX](https://github.com/t8y2/dbx) installed with at least one connection configured
- Node.js 22.13.0 或更高版本

## License

Apache-2.0

---

## 中文说明

[DBX](https://github.com/t8y2/dbx) 的 MCP Server，让 AI 编程助手（Claude Code、Cursor 等）直接使用 DBX 中已配置的数据库连接查询数据。

### 特性

- **零配置** — 自动读取 DBX 的连接配置
- **9 个工具** — 列出/添加/删除连接、列出表、查看表结构、获取 Schema 上下文、执行 SQL、执行 Redis 命令、在 DBX 中打开表
- **连接池** — 跨查询复用数据库连接
- **直接执行** — PostgreSQL、MySQL、SQLite 及兼容数据库（Doris、StarRocks 等）无需打开 DBX 即可查询
- **默认允许常规写入** — `INSERT` / `UPDATE` / `DELETE` 可直接执行，危险语句仍需显式开启
- **DBX UI 联动** — 从 AI 助手直接在 DBX 桌面端打开表

### 快速开始

#### 1. 安装

```bash
npm install -g @dbx-app/mcp-server
```

或直接运行：

```bash
npx @dbx-app/mcp-server
```

#### 2. 配置 Claude Code

在项目的 `.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "dbx": {
      "command": "dbx-mcp-server"
    }
  }
}
```

Windows 便携版需要在 MCP 配置中设置 `DBX_DATA_DIR`，指向包含 `dbx.db` 的便携版数据目录：

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

#### 3. 使用

在 Claude Code 中直接说：

- "列出我的数据库连接"
- "查看 local-pg 上有哪些表"
- "查看 users 表的结构"
- "查询最近 7 天的订单数量"
- "打开 orders 表"

### CLI

终端、脚本和 Codex 工作流请安装独立 CLI 包：

```bash
npm install -g @dbx-app/cli
dbx connections list --json
dbx query local "select 1" --json
```

命令详情见 [DBX CLI README](../cli/README.md)。

### 工具列表

| 工具                        | 说明                                  |
| --------------------------- | ------------------------------------- |
| `dbx_list_connections`      | 列出 DBX 中所有已配置的数据库连接     |
| `dbx_add_connection`        | 添加新的数据库连接                    |
| `dbx_remove_connection`     | 删除数据库连接                        |
| `dbx_list_tables`           | 列出指定连接的表和视图                |
| `dbx_describe_table`        | 获取表的列定义                        |
| `dbx_get_schema_context`    | 获取适合 AI 写 SQL 的紧凑表结构上下文 |
| `dbx_execute_query`         | 执行 SQL 查询（最多返回 100 行）      |
| `dbx_execute_redis_command` | 在 Redis 连接上执行 Redis 命令        |
| `dbx_open_table`            | 在 DBX 桌面端打开指定表               |

### SQL 安全

`dbx_execute_query` 支持多条 SQL 语句，会逐条完成安全检查并依次执行。默认允许常规写操作，例如 `INSERT`、`UPDATE`、`DELETE ... WHERE ...`。

如果你希望 MCP 会话强制退回只读，可设置：

```bash
DBX_MCP_ALLOW_WRITES=0
```

`DROP`、`TRUNCATE`、`ALTER` 等危险语句仍会被拦截，除非额外设置：

```bash
DBX_MCP_ALLOW_DANGEROUS_SQL=1
```

Redis 连接使用 `dbx_execute_redis_command`，不通过 `dbx_execute_query` 执行。Redis 写命令遵循 `DBX_MCP_ALLOW_WRITES`；`KEYS`、`FLUSHALL`、`EVAL` 等危险 Redis 命令需要设置 `DBX_MCP_ALLOW_DANGEROUS_SQL=1`。

### 工作原理

MCP Server 从 DBX 的 SQLite 数据库读取连接信息：

- **macOS**: `~/Library/Application Support/com.dbx.app/dbx.db`
- **Linux**: `~/.local/share/com.dbx.app/dbx.db`
- **Windows**: `%APPDATA%\com.dbx.app\dbx.db`

Windows 便携版的数据通常在 `DBX.exe` 同级的 `data\dbx.db`。请把 `DBX_DATA_DIR` 设置为这个 `data` 文件夹，不要手工复制 `dbx.db` 到默认目录。

### DBX UI 联动

`dbx_open_table` 工具通过本地 HTTP 接口与运行中的 DBX 应用通信，直接在 UI 中打开表。需要 DBX 正在运行。

PostgreSQL、MySQL、SQLite、Doris、StarRocks、Redshift 查询可由 MCP Server 直接执行。Redis standalone 命令执行也会直接连接。其他数据库类型，以及 Redis Sentinel/Cluster 或 SSH Redis 连接，仍会走 DBX 桌面端 bridge，除非配置了 `DBX_WEB_URL` 使用 Web 后端。

### 系统要求

- 已安装 [DBX](https://github.com/t8y2/dbx) 并配置了至少一个数据库连接
- Node.js 22.13.0 or newer
