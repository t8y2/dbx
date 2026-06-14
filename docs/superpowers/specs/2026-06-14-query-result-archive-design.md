# Query Result Archive Design

## Goal

Allow users to save the execution results recorded on a query tab to a compact file and later import that file to restore the same switchable result runs.

## Format

The archive file extension is `.dbxresults`. The payload is a MessagePack envelope with a DBX-specific magic string, version, lightweight query-tab metadata, and an embedded result snapshot. The embedded snapshot reuses the existing tab-result-cache codec, which already stores rows in columnar form and strips live session handles. This keeps the format smaller than JSON and avoids maintaining two independent row encodings.

The archive stores:

- query title, connection id, database, schema, SQL draft, and last executed SQL
- all result runs and the active result-run id
- result rows, column names/types, affected rows, execution time, error result tables, and multi-statement results
- result presentation metadata such as sort, pagination, count SQL, editability metadata, and table metadata

The archive does not store connection passwords, connection configuration, editor viewport state, running execution ids, or live result-session handles.

## User Flow

Export is available from the query result pane when a query tab has result output. The default file name is based on the tab title and uses the `.dbxresults` extension.

Import is available from the query editor toolbar even when the current tab has no result output. Import creates a new query tab instead of mutating the current draft. The imported tab projects the archived active run into the result grid immediately, while still allowing the user to edit the restored SQL draft.

## Error Handling

Invalid files, unsupported archive versions, and files without a decodable result snapshot are rejected without changing open tabs. UI callers show a toast with the error message. If an imported archive references a connection id that is not present locally, the tab still opens and displays archived results; re-execution depends on the user selecting a valid connection.

## Testing

Unit tests cover archive encoding/decoding, invalid archive rejection, compact binary behavior for repeated result rows, and query-store import into a new tab with switchable result runs. Existing query-store, persistence, tab-result-cache, and presentation tests remain part of the regression set.
