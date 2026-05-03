# Table Structure Editor

The Table Structure Editor provides a visual interface for modifying table schemas. Instead of writing `ALTER TABLE` statements by hand, you can add, modify, and delete columns and indexes through a form-based UI.

## Column Editor

The column editor displays all columns of the selected table in an editable list. For each column, you can modify:

- **Name** -- Rename the column
- **Type** -- Change the data type
- **Nullable** -- Toggle whether the column allows NULL values
- **Default** -- Set or change the default value
- **Comment** -- Add or update the column comment (on supported engines)

You can also:

- **Add a column** -- Append a new column definition to the table
- **Delete a column** -- Remove an existing column from the table

## Index Management

Below the column list, the index section lets you manage table indexes:

- View existing indexes and their columns
- Create new indexes (unique, non-unique)
- Remove existing indexes

## SQL Preview

Before applying any structural changes, DBX generates and displays the corresponding SQL statements (`ALTER TABLE ADD COLUMN`, `ALTER TABLE MODIFY COLUMN`, `DROP COLUMN`, `CREATE INDEX`, etc.). You can review the exact SQL that will be executed and confirm or cancel.

## Database Support

The Table Structure Editor supports the following database engines:

| Engine | Support |
|---|---|
| MySQL | Full support |
| PostgreSQL | Full support |
| SQLite | Full support |
| SQL Server | Full support |

Behavior adapts to the capabilities and syntax of each engine. For example, SQLite's limited `ALTER TABLE` support is handled transparently by DBX.
