# Query Editor

The Query Editor is the primary workspace for writing and executing SQL in DBX. It is built on CodeMirror 6, providing a fast, modern editing experience with deep database awareness.

## Syntax Highlighting

The editor applies language-aware syntax highlighting for SQL. Keywords, identifiers, strings, numbers, and comments are visually distinguished, making queries easier to read and write.

## Autocomplete

As you type, the editor suggests completions drawn from your actual database metadata:

- **Keywords** -- standard SQL keywords (`SELECT`, `FROM`, `WHERE`, etc.)
- **Table names** -- all tables and views visible in the current connection
- **Column names** -- columns scoped to the tables referenced in your query
- **JOIN suggestions** -- when typing a `JOIN` clause, the editor suggests related tables and join conditions based on foreign key relationships

Completions appear automatically and can also be triggered manually with the platform shortcut.

## Executing Queries

| Action | Shortcut |
|---|---|
| Execute the current query | `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux) |
| Execute selected text | Select text, then `Cmd+Enter` / `Ctrl+Enter` |

When no text is selected, the editor executes the full content of the editor. When a portion of text is selected, only that selection is executed. This is useful for running a single statement out of a multi-statement script.

Results appear immediately below the editor in the Data Grid.

## SQL Formatting

Use the format button in the toolbar to auto-format your SQL. The formatter standardizes indentation, keyword casing, and line breaks so that complex queries are easier to read and review.

## Query History

Every executed query is recorded in your local query history. You can open the history panel to:

- Browse previously executed queries
- Search through past queries by keyword
- Re-open a previous query in the editor with a single click

Query history is stored per connection, so switching connections shows only the relevant history.
