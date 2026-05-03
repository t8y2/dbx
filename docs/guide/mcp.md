# MCP Integration

## What is MCP?

MCP (Model Context Protocol) is an open protocol that lets AI coding agents (Claude Code, Cursor, etc.) call external tools. DBX's MCP Server exposes your database connections to AI agents, so you can query databases using natural language without writing SQL manually.

```
You: "Show me the order volume trend for the last 7 days"

AI Agent → MCP Server → Your Database → Results
                ↓
         DBX connection configs (with passwords)
```

## Quick Start

### 1. Install

```bash
npm install -g @dbx-app/mcp-server
```

### 2. Configure Your AI Agent

Create `.mcp.json` in your working directory:

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

### 3. Start Using

Just ask your AI agent:

- "List my database connections"
- "Show the tables in my local-pg connection"
- "Describe the users table"
- "Query the average salary from employees"
- "Open the orders table" (requires DBX running)

## Supported AI Agents

| Agent | Status | Configuration |
|---|---|---|
| Claude Code | ✅ Native | `.mcp.json` |
| Cursor | ✅ Supported | `.cursor/mcp.json` |
| Windsurf | ✅ Supported | `.windsurfrules` |
| VS Code + Copilot | ✅ Supported | MCP extension |

## Tools

### `dbx_list_connections`

List all database connections configured in DBX.

**Example:**
> "List my database connections"

**Response:**
```
| Name     | Type     | Host      | Port | Database |
| -------- | -------- | --------- | ---- | -------- |
| local-pg | postgres | 127.0.0.1 | 5432 |          |
| prod-db  | mysql    | db.example| 3306 | myapp    |
```

### `dbx_list_tables`

List tables and views for a connection.

| Parameter | Required | Description |
|---|---|---|
| `connection_name` | Yes | DBX connection name |
| `schema` | No | Schema name (default: public) |

### `dbx_describe_table`

Get column definitions for a table.

| Parameter | Required | Description |
|---|---|---|
| `connection_name` | Yes | DBX connection name |
| `table` | Yes | Table name |
| `schema` | No | Schema name (default: public) |

**Response:**
```
| Column      | Type      | Nullable | Default | Comment    |
| ----------- | --------- | -------- | ------- | ---------- |
| id (PK)     | integer   | NO       |         |            |
| user_id     | integer   | NO       |         | User ID    |
| total       | numeric   | NO       | 0       | Order total|
| created_at  | timestamp | NO       | now()   |            |
```

### `dbx_execute_query`

Execute a SQL query and return results (max 100 rows).

| Parameter | Required | Description |
|---|---|---|
| `connection_name` | Yes | DBX connection name |
| `sql` | Yes | SQL query |

### `dbx_open_table`

Open a table in DBX desktop app UI. **Requires DBX to be running.**

| Parameter | Required | Description |
|---|---|---|
| `connection_name` | Yes | DBX connection name |
| `table` | Yes | Table name |
| `database` | No | Database name |
| `schema` | No | Schema name |

DBX will open a new tab with the table data and bring the window to front.

### `dbx_execute_and_show`

Execute a SQL query in DBX desktop app UI. **Requires DBX to be running.**

| Parameter | Required | Description |
|---|---|---|
| `connection_name` | Yes | DBX connection name |
| `sql` | Yes | SQL query |
| `database` | No | Database name |

## How It Works

### Connection Configs

The MCP Server reads DBX's connection config files:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/com.dbx.app/connections.json` |
| Linux | `~/.config/com.dbx.app/connections.json` |
| Windows | `%APPDATA%\com.dbx.app\connections.json` |

Passwords are retrieved from the system keyring (macOS Keychain / Linux Secret Service / Windows Credential Manager).

### UI Integration

`dbx_open_table` and `dbx_execute_and_show` communicate with the running DBX app via a local HTTP interface:

```
AI Agent → MCP Server → HTTP localhost → DBX backend → Tauri event → Frontend opens tab
```

### Supported Databases

MCP query support: PostgreSQL, MySQL, and compatible databases (Doris, StarRocks, etc.). UI integration (open table) supports all database types in DBX.

## FAQ

**MCP Server can't connect to my database**
:   Check that the connection works in DBX first. The MCP Server uses the same config and credentials.

**`dbx_open_table` says "DBX is not running"**
:   Start the DBX desktop app first. UI integration requires DBX's local HTTP service.

**Connection name not found**
:   Connection name matching is case-insensitive but must match exactly. Use `dbx_list_connections` to see all available names.

**Query timeout**
:   MCP Server has a 30-second query timeout. Consider adding indexes or simplifying your query.

## Requirements

- [DBX](https://github.com/t8y2/dbx) installed with at least one connection configured
- Node.js 18+
- UI integration requires DBX v0.3.9+
