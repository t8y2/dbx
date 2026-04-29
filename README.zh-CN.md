<div align="center">
  <img src="public/favicon.png" width="80" />
  <h1>DBX</h1>
  <p>开源、轻量、跨平台的数据库管理工具。</p>
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
    <a href="README.md">English</a> | 简体中文
  </p>
</div>

## 功能特性

- **8 种数据库** — MySQL、PostgreSQL、SQLite、Redis、MongoDB、DuckDB、ClickHouse、SQL Server
- **结构浏览** — 数据库、Schema、表、字段、索引、外键、触发器
- **查询编辑器** — CodeMirror 语法高亮、自动补全、Cmd+Enter 执行
- **数据表格** — 虚拟滚动、行内编辑、排序、分页、列宽调整
- **数据导出** — CSV、JSON、Markdown
- **Redis 浏览器** — 模式匹配搜索，支持全部数据类型查看
- **MongoDB 浏览器** — 文档增删改查、分页浏览
- **查询历史** — 持久化存储，支持搜索、恢复、一键复制
- **安全防护** — 执行 DROP / DELETE / TRUNCATE / ALTER 时弹出确认对话框
- **自动重连** — 连接断开后透明重试
- **SSH 隧道** — 通过 SSH 端口转发连接数据库
- **深色模式** — 明暗主题一键切换
- **多语言** — English & 简体中文
- **极致轻量** — 安装包仅 ~7 MB（不内嵌 Chromium）

## 截图

<div align="center">
  <img src="docs/screenshot.png" width="800" />
</div>

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77

### 开发

```bash
pnpm install
pnpm tauri dev
```

### 构建

```bash
pnpm tauri build
```

安装包输出在 `src-tauri/target/release/bundle/` 目录。

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | [Tauri 2](https://tauri.app/) |
| 前端 | [Vue 3](https://vuejs.org/) + TypeScript |
| UI | [shadcn-vue](https://www.shadcn-vue.com/) + Tailwind CSS |
| 编辑器 | [CodeMirror 6](https://codemirror.net/) |
| 后端 | Rust + [sqlx](https://github.com/launchbadge/sqlx) / [tiberius](https://github.com/prisma/tiberius) / [redis-rs](https://github.com/redis-rs/redis-rs) / [mongodb](https://github.com/mongodb/mongo-rust-driver) |

## 开源协议

[MIT](LICENSE)
