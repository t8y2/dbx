# Data Transfer

Data Transfer moves data between two database connections, even when they use different database engines. This is useful for migrating data, populating a development environment, or consolidating data from multiple sources.

## Setting Up a Transfer

1. Select the **source** connection and database.
2. Select the **target** connection and database.
3. Choose the tables you want to transfer.

You can transfer all tables at once or pick a subset. DBX handles the necessary type mapping between different database engines automatically.

## Cross-Engine Support

Data Transfer works across different database engines. For example, you can transfer data from MySQL to PostgreSQL, or from SQLite to SQL Server. DBX translates data types and adapts insert statements as needed for the target engine.

## Progress Tracking

During the transfer, a progress indicator shows:

- Which table is currently being transferred
- How many rows have been transferred so far
- The overall progress across all selected tables

This lets you monitor long-running transfers without guessing how much work remains.

## Error Handling

If an error occurs during transfer (for example, a type incompatibility or a constraint violation), DBX reports the error with details about which table and row caused the problem. The transfer can be reviewed and retried after correcting the issue.
