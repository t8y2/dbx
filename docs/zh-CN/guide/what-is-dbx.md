# 什么是 DBX？

DBX 是一款开源、轻量、跨平台的数据库管理工具，基于 [Tauri 2](https://tauri.app/) 和 Rust 构建。

<div style="text-align:center">
  <img src="/screenshot.png" alt="DBX 截图" style="max-width:100%;border-radius:8px;margin:16px 0" />
</div>

## 为什么选择 DBX？

- **轻量** — 安装包约 15 MB，不内嵌 Chromium
- **多数据库** — 一个工具管理 MySQL、PostgreSQL、SQLite、Redis、MongoDB 等 13+ 种数据库
- **AI 驱动** — 内置 AI 助手 + MCP Server 对接外部 AI 编程助手
- **安全** — 密码存储在系统钥匙串，支持 SSH 隧道，加密配置导出
- **跨平台** — macOS、Windows、Linux

## 技术栈

| 层级 | 技术 |
|---|---|
| 框架 | [Tauri 2](https://tauri.app/) |
| 前端 | [Vue 3](https://vuejs.org/) + TypeScript |
| UI | [shadcn-vue](https://www.shadcn-vue.com/) + Tailwind CSS |
| 编辑器 | [CodeMirror 6](https://codemirror.net/) |
| 后端 | Rust + sqlx / tiberius / redis-rs / mongodb |

## 开源协议

[MIT](https://github.com/t8y2/dbx/blob/main/LICENSE)
