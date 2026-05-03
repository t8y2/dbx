# SQL File Execution

SQL File Execution lets you run `.sql` files directly within DBX, with progress tracking and the ability to cancel mid-execution. This is useful for running migration scripts, seed data, or database setup files.

## Running a SQL File

1. Open the SQL File Execution panel.
2. Select a `.sql` file from your filesystem.
3. Choose the target connection and database.
4. Click execute.

## Progress Tracking

During execution, DBX displays:

- The total number of statements detected in the file
- How many statements have been executed so far
- The currently executing statement

This gives you visibility into long-running scripts without waiting blindly for completion.

## Smart Statement Splitting

DBX parses the SQL file intelligently rather than naively splitting on semicolons. The parser correctly handles:

- **Functions and procedures** -- Multi-statement bodies with `BEGIN...END` blocks are treated as a single unit.
- **Triggers** -- `CREATE TRIGGER` statements with embedded logic are kept intact.
- **Quoted strings** -- Semicolons inside string literals or identifiers are not treated as statement delimiters.

This ensures that complex SQL files execute correctly without requiring manual editing.

## Cancelling Execution

If you need to stop execution before the file finishes, click the cancel button. DBX will stop after the current statement completes. Statements that have already been executed are not rolled back.
