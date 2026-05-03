# Data Grid

The Data Grid displays query results and table data in a high-performance, spreadsheet-like interface. It supports browsing large datasets, inline editing, and exporting data in multiple formats.

## Virtual Scrolling

The grid uses virtual scrolling to handle large result sets efficiently. Only the rows visible on screen are rendered at any given time, so performance remains consistent whether you are viewing 100 rows or 100,000 rows.

## Inline Editing

You can edit data directly in the grid without writing SQL manually. The following operations are supported:

- **UPDATE** -- Click a cell to modify its value. Changed cells are highlighted to indicate pending modifications.
- **INSERT** -- Add a new row at the bottom of the grid and fill in cell values.
- **DELETE** -- Select one or more rows and mark them for deletion.

### SQL Preview Before Saving

Before any changes are committed to the database, DBX shows a preview of the exact SQL statements that will be executed (`UPDATE`, `INSERT`, or `DELETE`). You can review the generated SQL and confirm or cancel.

## Sorting

Click a column header to sort by that column. Click again to toggle between ascending and descending order.

## Search and Filtering

- **Search** -- Use the search bar to find text across all visible columns.
- **WHERE Filter** -- Apply a custom `WHERE` clause to filter data at the database level. This is more efficient than client-side search for large tables because only matching rows are fetched.

## Column Resize and Row Numbers

- Drag column borders to resize columns to your preferred width.
- Row numbers are displayed in the leftmost column for easy reference.

## Export

Export the current result set in one of the following formats:

| Format | Description |
|---|---|
| CSV | Comma-separated values, compatible with Excel and other spreadsheet tools |
| JSON | Array of objects, suitable for use in code or APIs |
| Markdown | Markdown table, useful for pasting into documentation or chat |

Use the export button in the grid toolbar and select the desired format.
