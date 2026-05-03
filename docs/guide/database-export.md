# Database Export

Database Export generates a SQL dump of your database, including table definitions (DDL) and row data. The output is a `.sql` file that can be used to recreate the database or transfer it to another environment.

## What Gets Exported

The export includes:

- **DDL (Data Definition Language)** -- `CREATE TABLE` statements for all tables, including columns, types, defaults, constraints, and indexes.
- **Data** -- `INSERT` statements for all rows in each table.

## Batched INSERT Statements

To keep the export file manageable and compatible with database import tools, row data is written as batched `INSERT` statements. Instead of one `INSERT` per row, multiple rows are grouped into a single statement:

```sql
INSERT INTO users (id, name, email) VALUES
  (1, 'Alice', 'alice@example.com'),
  (2, 'Bob', 'bob@example.com'),
  (3, 'Carol', 'carol@example.com');
```

This reduces file size and improves import performance.

## Configurable Row Limit

You can set a maximum number of rows to export per table. This is useful when you need a representative sample of data rather than a full dump, or when working with very large tables where a complete export would be impractical.

Set the row limit to `0` or leave it blank to export all rows.

## Usage

1. Select the connection and database to export.
2. Configure the row limit (optional).
3. Choose the output file location.
4. Start the export.

The generated `.sql` file can be executed in DBX using the [SQL File Execution](./sql-file.md) feature, or in any compatible database client.
