# What is DBX?

DBX is an open-source, lightweight, cross-platform database management tool built with [Tauri 2](https://tauri.app/) and Rust.

<div style="text-align:center">
  <img src="/screenshot.png" alt="DBX Screenshot" style="max-width:100%;border-radius:8px;margin:16px 0" />
</div>

## Why DBX?

- **Lightweight** — ~15 MB installer, no bundled Chromium
- **Multi-database** — One tool for MySQL, PostgreSQL, SQLite, Redis, MongoDB, and 8 more
- **AI-powered** — Built-in AI assistant + MCP server for external AI agents
- **Secure** — Passwords in system keyring, SSH tunnels, encrypted config export
- **Cross-platform** — macOS, Windows, Linux

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Tauri 2](https://tauri.app/) |
| Frontend | [Vue 3](https://vuejs.org/) + TypeScript |
| UI | [shadcn-vue](https://www.shadcn-vue.com/) + Tailwind CSS |
| Editor | [CodeMirror 6](https://codemirror.net/) |
| Backend | Rust + sqlx / tiberius / redis-rs / mongodb |

## License

[MIT](https://github.com/t8y2/dbx/blob/main/LICENSE)
