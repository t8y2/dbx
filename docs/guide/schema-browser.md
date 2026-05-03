# Schema Browser

The Schema Browser is the sidebar panel that lets you explore the structure of all your connected databases. It presents your database objects in a navigable tree and provides quick actions via context menus.

## Tree View

The browser organizes objects in a hierarchical tree:

```
Connection
  +-- Database
        +-- Schema
              +-- Tables
              |     +-- Table
              |           +-- Column (type, nullable, default)
              +-- Views
```

Expand any node to drill down into its children. Column entries display their data type and other attributes inline.

## Search and Pin

- **Search** -- Use the search field at the top of the sidebar to filter the tree. The filter applies across all connections and matches table names, view names, and column names.
- **Pin** -- Pin frequently used tables or views to keep them at the top of the sidebar for quick access, regardless of how deep they are in the tree.

## Context Menus

Right-click any node in the tree to access context-specific actions. Examples include:

- **Table** -- Open data, open structure, copy table name, drop table
- **Column** -- Copy column name
- **Connection** -- Refresh metadata, disconnect

The available actions depend on the type of object selected.

## Column Comments

If your database supports column comments (e.g., MySQL `COMMENT`, PostgreSQL `COMMENT ON COLUMN`), the Schema Browser displays them alongside each column. This makes it easy to understand the purpose of columns without leaving the sidebar.

## Connection Colors

Each connection can be assigned a color. The color is displayed as a visual indicator in the tree and in tabs, helping you distinguish between environments (for example, green for development and red for production) at a glance.
