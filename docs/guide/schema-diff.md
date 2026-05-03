# Schema Diff

Schema Diff compares the structure of two databases and generates the SQL needed to synchronize them. This is useful for identifying differences between development and production environments, or between any two database instances.

## Comparing Schemas

To start a comparison:

1. Open the Schema Diff panel.
2. Select the **source** connection and database.
3. Select the **target** connection and database.
4. Run the comparison.

DBX analyzes both schemas and presents a side-by-side diff of all structural differences, including:

- Tables that exist in one database but not the other
- Columns that differ in type, default value, or nullability
- Index and constraint differences

## Generating Sync SQL

After the comparison is complete, DBX generates the SQL statements required to bring the target database in line with the source. This may include `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and related statements depending on the differences found.

You can review the generated SQL before taking any action.

## Executing Sync Directly

Once you have reviewed the generated SQL, you can execute it directly within DBX against the target database. There is no need to copy the SQL to an external tool -- the sync can be completed in a single workflow.

::: warning
Schema sync can make destructive changes (such as dropping tables or columns). Always review the generated SQL carefully before executing, and consider backing up the target database first.
:::
