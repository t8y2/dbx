# MCP 集成

## 什么是 MCP？

MCP（Model Context Protocol）是一个开放协议，让 AI 编程助手（Claude Code、Cursor 等）能够调用外部工具。DBX 的 MCP Server 把你在 DBX 中配置的数据库连接暴露给 AI 助手，这样你可以用自然语言查询数据库，而不需要手动写 SQL。

```
你："查看 orders 表最近 7 天的订单量趋势"

AI 助手 → MCP Server → 你的数据库 → 返回结果
                ↓
         DBX 的连接配置（含密码）
```

## 快速开始

### 1. 安装

```bash
npm install -g @dbx-app/mcp-server
```

### 2. 配置 AI 助手

在你的工作目录创建 `.mcp.json`：

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

### 3. 开始使用

在 AI 助手中直接说：

- "列出我的数据库连接"
- "查看 local-pg 上有哪些表"
- "查看 users 表的结构"
- "查询最近 7 天的订单数量"
- "打开 orders 表"（需要 DBX 运行中）

## 支持的 AI 助手

| 助手 | 支持情况 | 配置方式 |
|---|---|---|
| Claude Code | ✅ 原生支持 | `.mcp.json` |
| Cursor | ✅ 支持 | `.cursor/mcp.json` |
| Windsurf | ✅ 支持 | `.windsurfrules` |
| VS Code + Copilot | ✅ 支持 | MCP 扩展 |

## 工具列表

### `dbx_list_connections`

列出 DBX 中所有已配置的数据库连接。

**示例对话：**
> "列出我的数据库连接"

**返回：**
```
| Name     | Type     | Host      | Port | Database |
| -------- | -------- | --------- | ---- | -------- |
| local-pg | postgres | 127.0.0.1 | 5432 |          |
| prod-db  | mysql    | db.example| 3306 | myapp    |
```

### `dbx_list_tables`

列出指定连接的表和视图。

| 参数 | 必填 | 说明 |
|---|---|---|
| `connection_name` | 是 | DBX 连接名称 |
| `schema` | 否 | Schema 名称（默认 public） |

### `dbx_describe_table`

获取表的列定义。

| 参数 | 必填 | 说明 |
|---|---|---|
| `connection_name` | 是 | DBX 连接名称 |
| `table` | 是 | 表名 |
| `schema` | 否 | Schema 名称（默认 public） |

**返回：**
```
| Column      | Type      | Nullable | Default | Comment |
| ----------- | --------- | -------- | ------- | ------- |
| id (PK)     | integer   | NO       |         |         |
| user_id     | integer   | NO       |         | 用户 ID  |
| total       | numeric   | NO       | 0       | 订单金额 |
| created_at  | timestamp | NO       | now()   |         |
```

### `dbx_execute_query`

执行 SQL 查询，返回结果（最多 100 行）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `connection_name` | 是 | DBX 连接名称 |
| `sql` | 是 | SQL 查询语句 |

### `dbx_open_table`

在 DBX 桌面端打开指定表。**需要 DBX 正在运行。**

| 参数 | 必填 | 说明 |
|---|---|---|
| `connection_name` | 是 | DBX 连接名称 |
| `table` | 是 | 表名 |
| `database` | 否 | 数据库名 |
| `schema` | 否 | Schema 名称 |

DBX 会自动新开一个 tab 显示数据，窗口自动置前。

### `dbx_execute_and_show`

在 DBX 桌面端执行 SQL 并展示结果。**需要 DBX 正在运行。**

| 参数 | 必填 | 说明 |
|---|---|---|
| `connection_name` | 是 | DBX 连接名称 |
| `sql` | 是 | SQL 查询语句 |
| `database` | 否 | 数据库名 |

## 工作原理

### 连接配置

MCP Server 从 DBX 的配置目录读取连接信息：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.dbx.app/connections.json` |
| Linux | `~/.config/com.dbx.app/connections.json` |
| Windows | `%APPDATA%\com.dbx.app\connections.json` |

密码从系统钥匙串中获取（macOS Keychain / Linux Secret Service / Windows 凭据管理器）。

### UI 联动

`dbx_open_table` 和 `dbx_execute_and_show` 通过本地 HTTP 接口与运行中的 DBX 应用通信：

```
AI 助手 → MCP Server → HTTP localhost → DBX 后端 → Tauri 事件 → 前端打开 tab
```

### 支持的数据库

MCP 查询支持 PostgreSQL 和 MySQL（及兼容数据库：Doris、StarRocks 等）。UI 联动（打开表）支持 DBX 已支持的所有数据库类型。

## 常见问题

**MCP Server 连不上数据库**
:   检查 DBX 中该连接是否能正常连接。MCP Server 使用相同的连接配置和密码。

**`dbx_open_table` 报 "DBX is not running"**
:   需要先启动 DBX 桌面应用。UI 联动功能依赖 DBX 运行时的本地 HTTP 服务。

**连接名称找不到**
:   连接名称匹配不区分大小写，但需要和 DBX 中配置的名称一致。用 `dbx_list_connections` 查看所有可用名称。

**查询超时**
:   MCP Server 的查询超时为 30 秒。如果查询较慢，考虑添加索引或简化查询。

## 系统要求

- [DBX](https://github.com/t8y2/dbx) 已安装并配置了至少一个数据库连接
- Node.js 18+
- UI 联动功能需要 DBX v0.3.9+
