# DBX MCP Server

MCP server for [DBX](https://github.com/t8y2/dbx) — lets AI agents (Claude Code, Cursor, etc.) query your databases using connections already configured in DBX.

[中文](#中文说明) | English

## Features

- **Zero config** — Automatically reads your DBX connections (including passwords from system keyring)
- **7 tools** — List/add/remove connections, list tables, describe table, execute SQL, open table in DBX UI
- **Connection pooling** — Reuses database connections across queries
- **PostgreSQL & MySQL** — Supports PostgreSQL, MySQL, and compatible databases (Doris, StarRocks, etc.)
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

Or for development (from source):

```json
{
  "mcpServers": {
    "dbx": {
      "command": "npx",
      "args": ["tsx", "mcp/src/index.ts"],
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

## Tools

| Tool | Description |
|---|---|
| `dbx_list_connections` | List all database connections configured in DBX |
| `dbx_add_connection` | Add a new database connection |
| `dbx_remove_connection` | Remove a database connection |
| `dbx_list_tables` | List tables and views for a connection |
| `dbx_describe_table` | Get column definitions for a table |
| `dbx_execute_query` | Execute a SQL query (max 100 rows) |
| `dbx_open_table` | Open a table in DBX desktop app UI |

## How It Works

```
AI Agent → MCP Server → Database
                ↓
         DBX SQLite database (dbx.db)
```

The MCP server reads your database connections from DBX's SQLite database:

- **macOS**: `~/Library/Application Support/com.dbx.app/dbx.db`
- **Linux**: `~/.config/com.dbx.app/dbx.db`
- **Windows**: `%APPDATA%\com.dbx.app\dbx.db`

## DBX UI Integration

The `dbx_open_table` tool communicates with the running DBX app to open tables directly in the UI. This requires DBX to be running. If DBX is not running, the tool will return an error message.

## Requirements

- [DBX](https://github.com/t8y2/dbx) installed with at least one connection configured
- Node.js 18+

## License

MIT

---

## 中文说明

[DBX](https://github.com/t8y2/dbx) 的 MCP Server，让 AI 编程助手（Claude Code、Cursor 等）直接使用 DBX 中已配置的数据库连接查询数据。

### 特性

- **零配置** — 自动读取 DBX 的连接配置
- **7 个工具** — 列出/添加/删除连接、列出表、查看表结构、执行 SQL、在 DBX 中打开表
- **连接池** — 跨查询复用数据库连接
- **PostgreSQL 和 MySQL** — 支持 PostgreSQL、MySQL 及兼容数据库（Doris、StarRocks 等）
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

#### 3. 使用

在 Claude Code 中直接说：

- "列出我的数据库连接"
- "查看 local-pg 上有哪些表"
- "查看 users 表的结构"
- "查询最近 7 天的订单数量"
- "打开 orders 表"

### 工具列表

| 工具 | 说明 |
|---|---|
| `dbx_list_connections` | 列出 DBX 中所有已配置的数据库连接 |
| `dbx_add_connection` | 添加新的数据库连接 |
| `dbx_remove_connection` | 删除数据库连接 |
| `dbx_list_tables` | 列出指定连接的表和视图 |
| `dbx_describe_table` | 获取表的列定义 |
| `dbx_execute_query` | 执行 SQL 查询（最多返回 100 行） |
| `dbx_open_table` | 在 DBX 桌面端打开指定表 |

### 工作原理

MCP Server 从 DBX 的 SQLite 数据库读取连接信息：

- **macOS**: `~/Library/Application Support/com.dbx.app/dbx.db`
- **Linux**: `~/.config/com.dbx.app/dbx.db`
- **Windows**: `%APPDATA%\com.dbx.app\dbx.db`

### DBX UI 联动

`dbx_open_table` 工具通过本地 HTTP 接口与运行中的 DBX 应用通信，直接在 UI 中打开表。需要 DBX 正在运行。

### 系统要求

- 已安装 [DBX](https://github.com/t8y2/dbx) 并配置了至少一个数据库连接
- Node.js 18+
