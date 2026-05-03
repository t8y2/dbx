# Field Lineage

Field Lineage helps you understand how columns in your database relate to each other. It traces relationships across foreign keys, views, and query history to give you a complete picture of where data comes from and where it flows.

## Relationship Sources

DBX discovers column relationships from multiple sources, each with a different confidence level:

### Foreign Key Relationships (Certain)

Relationships defined by foreign key constraints in the database schema. These are authoritative and marked with **certain** confidence because they are explicitly declared in the schema.

### View References (Likely)

When a view references columns from underlying tables, DBX traces those references. These relationships are marked with **likely** confidence because they are derived from view definitions rather than explicit constraints.

### Query History References

DBX analyzes your local query history to identify columns that are frequently joined or referenced together. These relationships are inferred from usage patterns.

### Same-Name Column Detection

Columns that share the same name across different tables are flagged as potential relationships. This heuristic is useful for discovering implicit conventions (such as `user_id` appearing in multiple tables) that are not enforced by foreign keys.

## Searching and Filtering

The lineage panel provides:

- **Search** -- Filter relationships by table name or column name.
- **Confidence filter** -- Show only relationships at a specific confidence level (certain, likely, or all). This lets you focus on verified relationships or explore speculative ones.

## Click-Through Navigation

Click any related table or column in the lineage view to navigate directly to it. This opens the target table in the Data Grid or Schema Browser, making it easy to follow data relationships across your schema without manually searching.
