<div align="center">
  <img src="public/favicon.png" width="80" />
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
  </p>
  <p>
    English | <a href="README.zh-CN.md">简体中文</a>
  </p>
</div>

## Features

- **8 databases** — MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server
- **Schema browser** — Databases, schemas, tables, columns, indexes, foreign keys, triggers
- **Query editor** — CodeMirror with syntax highlighting, auto-complete, Cmd+Enter execution
- **Data grid** — Virtual-scrolled table with inline editing, sorting, pagination, column resize
- **Export** — CSV, JSON, Markdown
- **Redis browser** — Key pattern search, value viewer for all data types
- **MongoDB browser** — Document CRUD with pagination
- **Query history** — Persistent history with search, restore, and one-click copy
- **Safety** — Confirmation dialog for DROP / DELETE / TRUNCATE / ALTER
- **Auto-reconnect** — Transparent retry on connection loss
- **SSH tunnel** — Connect through SSH port forwarding
- **Dark mode** — System-aware theme toggle
- **i18n** — English & 简体中文
- **Tiny** — ~7 MB installer (no bundled Chromium)

## Screenshot

<div align="center">
  <img src="docs/screenshot.png" width="800" />
</div>

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

## Install

Download the latest release from the [Releases](https://github.com/t8y2/dbx/releases) page.

### macOS Note

DBX is not signed with an Apple Developer certificate. On first launch, macOS will block the app. To fix this:

```bash
xattr -cr /Applications/dbx.app
```

Or: **System Settings → Privacy & Security → Open Anyway**.

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
