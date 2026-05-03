# AI Assistant

DBX has a built-in AI assistant that helps you write, explain, optimize, and fix SQL queries.

## Setup

1. Click the **Settings** icon in the toolbar
2. Go to **AI Settings**
3. Choose your provider (Claude or OpenAI)
4. Enter your API key
5. Select a model

## Features

### Natural Language to SQL

Describe what you want to query in plain language:

> "Show me the top 10 customers by total order amount"

The AI assistant will generate the SQL based on your database schema.

### Explain SQL

Select a SQL query and ask the AI to explain what it does.

### Optimize SQL

Get suggestions for improving query performance.

### Fix Errors

When a query fails, click **Fix with AI** to get a corrected version.

## Supported Providers

| Provider | Models |
|---|---|
| Anthropic (Claude) | Claude 4 Opus, Claude 4 Sonnet, Claude 3.5 Haiku |
| OpenAI | GPT-4o, GPT-4o-mini, o3-mini |
| Compatible | Any OpenAI-compatible API endpoint |

## Beyond Built-in AI

For a more powerful AI-driven database experience, try the [MCP integration](/guide/mcp). It lets AI coding agents like Claude Code and Cursor directly query your databases and open results in DBX.
