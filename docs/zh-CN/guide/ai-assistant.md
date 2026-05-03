# AI 助手

DBX 内置 AI 助手，帮你编写、解释、优化和修复 SQL 查询。

## 设置

1. 点击工具栏的 **设置** 图标
2. 进入 **AI 设置**
3. 选择供应商（Claude 或 OpenAI）
4. 输入 API Key
5. 选择模型

## 功能

### 自然语言转 SQL

用自然语言描述你想查询的内容：

> "查看最近 10 个订单金额最高的客户"

AI 助手会根据你的数据库结构生成 SQL。

### 解释 SQL

选中一段 SQL 查询，让 AI 解释它的作用。

### 优化 SQL

获取查询性能优化建议。

### 修复错误

查询执行失败时，点击 **AI 修复** 获取修正后的版本。

## 支持的供应商

| 供应商 | 模型 |
|---|---|
| Anthropic (Claude) | Claude 4 Opus、Claude 4 Sonnet、Claude 3.5 Haiku |
| OpenAI | GPT-4o、GPT-4o-mini、o3-mini |
| 兼容接口 | 任何 OpenAI 兼容的 API 端点 |

## 更强大的 AI 体验

除了内置 AI 助手，还可以试试 [MCP 集成](/zh-CN/guide/mcp)。它让 Claude Code、Cursor 等 AI 编程助手直接查询你的数据库，并在 DBX 中打开结果。
