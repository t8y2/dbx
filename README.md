<div align="center">
  <img src="docs/logo.png" width="80" />
  <h1>DBX</h1>
  <p>Open-source, lightweight, cross-platform database management tool.</p>
  <p>
    <a href="https://github.com/t8y2/dbx/releases"><img src="https://img.shields.io/github/v/release/t8y2/dbx?label=version" /></a>
    <a href="https://github.com/t8y2/dbx/releases"><img src="https://img.shields.io/github/downloads/t8y2/dbx/total" /></a>
    <a href="https://github.com/t8y2/dbx/blob/main/LICENSE"><img src="https://img.shields.io/github/license/t8y2/dbx" /></a>
    <a href="https://github.com/t8y2/dbx/graphs/contributors"><img src="https://img.shields.io/github/contributors/t8y2/dbx" /></a>
    <a href="https://linux.do"><img src="https://img.shields.io/badge/community-LINUX%20DO-blue" /></a>
    <a href="#community"><img src="https://img.shields.io/badge/WeChat%20%7C%20QQ-Join%20Group-brightgreen" /></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white" />
    <img src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" />
    <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" />
    <img src="https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white" />
    <img src="https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white" />
    <img src="https://img.shields.io/badge/DuckDB-FFF000?logo=duckdb&logoColor=black" />
    <img src="https://img.shields.io/badge/ClickHouse-FFCC01?logo=clickhouse&logoColor=black" />
    <img src="https://img.shields.io/badge/SQL%20Server-CC2927?logo=microsoftsqlserver&logoColor=white" />
    <img src="https://img.shields.io/badge/Oracle-F80000?logo=oracle&logoColor=white" />
    <img src="https://img.shields.io/badge/MariaDB-003545?logo=mariadb&logoColor=white" />
    <img src="https://img.shields.io/badge/TiDB-DC150B?logo=tidb&logoColor=white" />
  </p>
  <p>
    English | <a href="README.zh-CN.md">简体中文</a>
  </p>
</div>

## Features

- **Multi-database** — MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, Oracle, MariaDB, TiDB, OceanBase, openGauss, GaussDB, KingBase, Vastbase, GoldenDB
- **Schema browser** — Databases, schemas, tables, columns, indexes, foreign keys, triggers, with sidebar search & pin
- **Query editor** — CodeMirror 6 with syntax highlighting, SQL autocomplete (tables & columns), Cmd+Enter execution, selected SQL execution, SQL formatting
- **AI SQL assistant** — Natural language to SQL, explain, optimize, fix errors (Claude / OpenAI)
- **Data grid** — Virtual-scrolled table with inline editing, sorting, search, pagination, column resize, row numbers, zebra stripes
- **Export** — CSV, JSON, Markdown
- **File preview** — Drag & drop Parquet, CSV, JSON files to preview data instantly (powered by DuckDB)
- **Redis browser** — Key pattern search, value viewer for all data types (String, Hash, List, Set, ZSet, Stream)
- **MongoDB browser** — Document CRUD with pagination, direct URL connection (Atlas, replica sets)
- **Query history** — Persistent history with search, restore, one-click copy
- **Safety** — Confirmation dialog for DROP / DELETE / TRUNCATE / ALTER
- **Auto-reconnect** — Transparent retry on connection loss
- **SSH tunnel** — Key and password authentication
- **Connection colors** — Color-coded connections for visual identification
- **Auto-update** — Built-in update checker with release notifications
- **Dark mode** — Native title bar theme sync
- **i18n** — English & 简体中文
- **Tiny** — ~15 MB installer (no bundled Chromium)

## AI Agent Integration (MCP)

DBX provides an [MCP server](mcp/) that lets AI coding agents query your databases using connections already configured in DBX.

```bash
npx @dbx-app/mcp-server
```

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "dbx": { "command": "npx", "args": ["-y", "@dbx-app/mcp-server"] }
  }
}
```

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible agent. Supports listing connections, browsing tables, executing SQL, and opening tables directly in DBX's UI.

See the [MCP server README](mcp/README.md) for details.

## Screenshot

<div align="center">
  <img src="docs/screenshot.png" width="800" />
  <p>
    <img src="docs/screenshot-connections.jpg" width="395" />
    <img src="docs/screenshot-ai.jpg" width="395" />
  </p>
</div>

## Install

Download the latest release from the [Releases](https://github.com/t8y2/dbx/releases) page.

**Homebrew (macOS):**

```bash
brew install --cask t8y2/tap/dbx
```

**Scoop (Windows):**

```bash
scoop bucket add dbx https://github.com/t8y2/scoop-bucket
scoop install dbx
```

### macOS Note

DBX is not signed with an Apple Developer certificate. On first launch, macOS will block the app. To fix this:

```bash
xattr -cr /Applications/DBX.app
```

Or: **System Settings → Privacy & Security → Open Anyway**.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77

### Development

```bash
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

The installer will be in `src-tauri/target/release/bundle/`.

## Tech Stack

| Layer     | Technology                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework | [Tauri 2](https://tauri.app/)                                                                                                                                                                                    |
| Frontend  | [Vue 3](https://vuejs.org/) + TypeScript                                                                                                                                                                         |
| UI        | [shadcn-vue](https://www.shadcn-vue.com/) + Tailwind CSS                                                                                                                                                         |
| Editor    | [CodeMirror 6](https://codemirror.net/)                                                                                                                                                                          |
| Backend   | Rust + [sqlx](https://github.com/launchbadge/sqlx) / [tiberius](https://github.com/prisma/tiberius) / [redis-rs](https://github.com/redis-rs/redis-rs) / [mongodb](https://github.com/mongodb/mongo-rust-driver) |

## Community

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-blue)](https://linux.do)

|                     WeChat Group                      |                     QQ Group                      |
| :---------------------------------------------: | :-----------------------------------------: |
| <img src="docs/wechat-group.jpg" width="200" /> | <img src="docs/qq-group.jpg" width="200" /> |

## Contributors

<a href="https://github.com/t8y2/dbx/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=t8y2/dbx&v=2" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=t8y2%2Fdbx&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=t8y2/dbx&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=t8y2/dbx&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=t8y2/dbx&type=date&legend=top-left" />
 </picture>
</a>

## License

[MIT](LICENSE)
