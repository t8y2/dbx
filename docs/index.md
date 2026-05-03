---
layout: home

hero:
  name: DBX
  text: Database Management Tool
  tagline: Open-source, lightweight, cross-platform. Supports 13+ databases with built-in AI assistant.
  image:
    src: /logo.png
    alt: DBX
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Download
      link: https://github.com/t8y2/dbx/releases
    - theme: alt
      text: GitHub
      link: https://github.com/t8y2/dbx

features:
  - icon: 🗄️
    title: 13+ Databases
    details: MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, Oracle, Elasticsearch, and many MySQL/PG-compatible databases.
    link: /guide/databases
    linkText: View all databases
  - icon: ✏️
    title: Query Editor
    details: CodeMirror 6 with syntax highlighting, smart SQL autocomplete for tables and columns, format SQL, execute selected text.
    link: /guide/query-editor
    linkText: Learn more
  - icon: 📊
    title: Data Grid
    details: Virtual-scrolled table with inline editing, sorting, search, WHERE filter, pagination. Edit data and preview SQL before saving.
    link: /guide/data-grid
    linkText: Learn more
  - icon: 🤖
    title: AI Assistant
    details: Natural language to SQL, explain, optimize, fix errors. Supports Claude, OpenAI, and any compatible API.
    link: /guide/ai-assistant
    linkText: Learn more
  - icon: 🔌
    title: MCP Integration
    details: Let Claude Code, Cursor and other AI agents query your databases and open tables in DBX directly.
    link: /guide/mcp
    linkText: Setup guide
  - icon: 🔄
    title: Schema Diff & Transfer
    details: Compare schemas across databases and generate sync SQL. Transfer data between different database engines.
    link: /guide/schema-diff
    linkText: Learn more
  - icon: 🔍
    title: Field Lineage
    details: Trace column dependencies through foreign keys, views, query history, and same-name fields across tables.
    link: /guide/field-lineage
    linkText: Learn more
  - icon: 🔒
    title: Secure & Lightweight
    details: Passwords in system keyring, SSH tunnel, encrypted config export. ~15 MB installer, no bundled Chromium.
    link: /guide/config-export
    linkText: Learn more
---

<style>
.screenshot-section {
  max-width: 1152px;
  margin: 0 auto;
  padding: 48px 24px;
}
.screenshot-section h2 {
  text-align: center;
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 24px;
}
.screenshot-section img {
  width: 100%;
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
}
.screenshot-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 16px;
}
.screenshot-grid img {
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08);
}
</style>

<div class="screenshot-section">
  <h2>See it in action</h2>
  <img src="/screenshot.png" alt="DBX main interface" />
  <div class="screenshot-grid">
    <img src="/screenshot-connections.jpg" alt="Connection dialog" />
    <img src="/screenshot-ai.jpg" alt="AI assistant" />
  </div>
</div>
