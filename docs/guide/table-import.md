# Table Import

Table Import lets you load data from local files into a database table. It supports common file formats and provides column mapping to ensure data lands in the right place.

## Supported Formats

| Format | Extensions |
|---|---|
| CSV | `.csv` |
| TSV | `.tsv` |
| JSON | `.json` |
| Excel | `.xlsx`, `.xls` |

## Import Workflow

1. Select the target connection, database, and table.
2. Choose a file to import.
3. Review the auto-generated column mapping.
4. Select the import mode.
5. Start the import.

## Column Mapping

After selecting a file, DBX reads the file headers (or keys, for JSON) and automatically maps them to columns in the target table by matching names. You can adjust the mapping manually if the names do not match exactly.

Unmapped file columns are skipped. Unmapped table columns receive their default value or NULL.

## Import Modes

| Mode | Behavior |
|---|---|
| **Append** | Insert the imported rows into the table alongside existing data. |
| **Truncate then import** | Delete all existing rows from the table first, then insert the imported data. |

::: warning
Truncate mode permanently removes all existing data in the target table before importing. Make sure this is the intended behavior before proceeding.
:::
