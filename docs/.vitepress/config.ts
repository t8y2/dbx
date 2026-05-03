import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'DBX',
  description: 'Open-source, lightweight, cross-platform database management tool',
  base: '/dbx/',
  head: [
    ['link', { rel: 'icon', href: '/dbx/logo.png' }],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/what-is-dbx' },
          {
            text: 'Features',
            items: [
              { text: 'Database Support', link: '/guide/databases' },
              { text: 'Query Editor', link: '/guide/query-editor' },
              { text: 'Data Grid', link: '/guide/data-grid' },
              { text: 'Schema Diff', link: '/guide/schema-diff' },
              { text: 'Data Transfer', link: '/guide/data-transfer' },
              { text: 'AI Assistant', link: '/guide/ai-assistant' },
              { text: 'MCP Integration', link: '/guide/mcp' },
            ],
          },
          { text: 'Changelog', link: 'https://github.com/t8y2/dbx/releases' },
          { text: 'Download', link: 'https://github.com/t8y2/dbx/releases' },
        ],
        sidebar: [
          {
            text: 'Introduction',
            items: [
              { text: 'What is DBX?', link: '/guide/what-is-dbx' },
              { text: 'Getting Started', link: '/guide/getting-started' },
              { text: 'Database Support', link: '/guide/databases' },
            ],
          },
          {
            text: 'Core Features',
            items: [
              { text: 'Query Editor', link: '/guide/query-editor' },
              { text: 'Data Grid', link: '/guide/data-grid' },
              { text: 'Schema Browser', link: '/guide/schema-browser' },
            ],
          },
          {
            text: 'Advanced Features',
            items: [
              { text: 'Schema Diff', link: '/guide/schema-diff' },
              { text: 'Data Transfer', link: '/guide/data-transfer' },
              { text: 'Table Structure Editor', link: '/guide/table-structure' },
              { text: 'Field Lineage', link: '/guide/field-lineage' },
              { text: 'Table Import', link: '/guide/table-import' },
              { text: 'SQL File Execution', link: '/guide/sql-file' },
              { text: 'Database Export', link: '/guide/database-export' },
            ],
          },
          {
            text: 'AI & Automation',
            items: [
              { text: 'AI Assistant', link: '/guide/ai-assistant' },
              { text: 'MCP Integration', link: '/guide/mcp' },
            ],
          },
          {
            text: 'Settings',
            items: [
              { text: 'Config Export/Import', link: '/guide/config-export' },
              { text: 'SSH Tunnel', link: '/guide/ssh-tunnel' },
            ],
          },
        ],
      },
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh-CN/guide/what-is-dbx' },
          {
            text: '功能',
            items: [
              { text: '数据库支持', link: '/zh-CN/guide/databases' },
              { text: '查询编辑器', link: '/zh-CN/guide/query-editor' },
              { text: '数据表格', link: '/zh-CN/guide/data-grid' },
              { text: 'Schema 对比', link: '/zh-CN/guide/schema-diff' },
              { text: '数据传输', link: '/zh-CN/guide/data-transfer' },
              { text: 'AI 助手', link: '/zh-CN/guide/ai-assistant' },
              { text: 'MCP 集成', link: '/zh-CN/guide/mcp' },
            ],
          },
          { text: '更新日志', link: 'https://github.com/t8y2/dbx/releases' },
          { text: '下载', link: 'https://github.com/t8y2/dbx/releases' },
        ],
        sidebar: [
          {
            text: '介绍',
            items: [
              { text: '什么是 DBX？', link: '/zh-CN/guide/what-is-dbx' },
              { text: '快速开始', link: '/zh-CN/guide/getting-started' },
              { text: '数据库支持', link: '/zh-CN/guide/databases' },
            ],
          },
          {
            text: '核心功能',
            items: [
              { text: '查询编辑器', link: '/zh-CN/guide/query-editor' },
              { text: '数据表格', link: '/zh-CN/guide/data-grid' },
              { text: '结构浏览', link: '/zh-CN/guide/schema-browser' },
            ],
          },
          {
            text: '高级功能',
            items: [
              { text: 'Schema 对比', link: '/zh-CN/guide/schema-diff' },
              { text: '数据传输', link: '/zh-CN/guide/data-transfer' },
              { text: '表结构编辑器', link: '/zh-CN/guide/table-structure' },
              { text: '字段血缘', link: '/zh-CN/guide/field-lineage' },
              { text: '表数据导入', link: '/zh-CN/guide/table-import' },
              { text: 'SQL 文件执行', link: '/zh-CN/guide/sql-file' },
              { text: '数据库导出', link: '/zh-CN/guide/database-export' },
            ],
          },
          {
            text: 'AI 与自动化',
            items: [
              { text: 'AI 助手', link: '/zh-CN/guide/ai-assistant' },
              { text: 'MCP 集成', link: '/zh-CN/guide/mcp' },
            ],
          },
          {
            text: '设置',
            items: [
              { text: '配置导出/导入', link: '/zh-CN/guide/config-export' },
              { text: 'SSH 隧道', link: '/zh-CN/guide/ssh-tunnel' },
            ],
          },
        ],
      },
    },
  },
  themeConfig: {
    logo: '/logo.png',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/t8y2/dbx' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@dbx-app/mcp-server' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present DBX Contributors',
    },
    search: {
      provider: 'local',
    },
  },
})
