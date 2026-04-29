<div align="center">
  <img src="docs/logo.png" width="80" />
  <h1>DBX</h1>
  <p>Open-source, lightweight, cross-platform database management tool.</p>
  <p>
    <img src="https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white" />
    <img src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" />
    <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" />
    <img src="https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white" />
    <img src="https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white" />
    <img src="https://img.shields.io/badge/DuckDB-FFF000?logo=duckdb&logoColor=black" />
    <img src="https://img.shields.io/badge/ClickHouse-FFCC01?logo=clickhouse&logoColor=black" />
    <img src="https://img.shields.io/badge/SQL%20Server-CC2927?logo=microsoftsqlserver&logoColor=white" />
    <img src="https://img.shields.io/badge/MariaDB-003545?logo=mariadb&logoColor=white" />
    <img src="https://img.shields.io/badge/TiDB-DC150B?logo=tidb&logoColor=white" />
  </p>
  <p>
    English | <a href="README.zh-CN.md">简体中文</a>
  </p>
</div>

## Features

- **Multi-database** — MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, MariaDB, TiDB, OceanBase, openGauss, GaussDB, KingBase, Vastbase, GoldenDB
- **Schema browser** — Databases, schemas, tables, columns, indexes, foreign keys, triggers
- **Query editor** — CodeMirror 6 with syntax highlighting, Cmd+Enter execution, Cmd+scroll zoom
- **AI SQL assistant** — Natural language to SQL, explain, optimize, fix errors (Claude / OpenAI)
- **Data grid** — Virtual-scrolled table with inline editing, sorting, search, pagination, column resize, row numbers, zebra stripes
- **Export** — CSV, JSON, Markdown
- **Redis browser** — Key pattern search, value viewer for all data types (String, Hash, List, Set, ZSet)
- **MongoDB browser** — Document CRUD with pagination
- **Query history** — Persistent history with search, restore, one-click copy
- **Safety** — Confirmation dialog for DROP / DELETE / TRUNCATE / ALTER
- **Auto-reconnect** — Transparent retry on connection loss
- **SSH tunnel** — Key and password authentication
- **File drag & drop** — Drag .db / .sqlite / .duckdb files to open directly
- **Dark mode** — Native title bar theme sync
- **i18n** — English & 简体中文
- **Tiny** — ~15 MB installer (no bundled Chromium)

## Screenshot

<div align="center">
  <img src="docs/screenshot.png" width="800" />
</div>

## Install

Download the latest release from the [Releases](https://github.com/t8y2/dbx/releases) page.

### macOS Note

DBX is not signed with an Apple Developer certificate. On first launch, macOS will block the app. To fix this:

```bash
xattr -cr /Applications/dbx.app
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

| Layer | Technology |
|-------|-----------|
| Framework | [Tauri 2](https://tauri.app/) |
| Frontend | [Vue 3](https://vuejs.org/) + TypeScript |
| UI | [shadcn-vue](https://www.shadcn-vue.com/) + Tailwind CSS |
| Editor | [CodeMirror 6](https://codemirror.net/) |
| Backend | Rust + [sqlx](https://github.com/launchbadge/sqlx) / [tiberius](https://github.com/prisma/tiberius) / [redis-rs](https://github.com/redis-rs/redis-rs) / [mongodb](https://github.com/mongodb/mongo-rust-driver) |

## License

[MIT](LICENSE)

## Community

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-blue)](https://linux.do)
