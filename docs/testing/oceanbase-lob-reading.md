# OceanBase Oracle LOB regression acceptance

This batch covers result-snapshot CLOB/BLOB reading, writing, copying and exporting. Target database acceptance uses OceanBase Oracle 4.2.5.7 and Connector/J 2.4.18. Automated tests with JDBC and transport fixtures do not establish support on other database versions.

## Reproduction and expected behavior

Use an authorized isolated table with a primary key, CLOB, BLOB and nullable temporal columns. Include SQL NULL, empty LOBs, Unicode text longer than the grid preview and binary data containing all byte values. Keep fixture credentials and connection details outside the PR.

1. Query the fixture, then update or delete its rows through a second connection. Read, copy and export the original result. The full value must come from its original retained locator and session; it must not use the preview or re-query the changed row. Expired references must report an error instead of opening another session.
2. Export selected cells and rows to CSV, JSON and XLSX. Compare complete values with the original fixture, including NULL versus empty text and empty binary data. Preserve selection, column order, header comments and existing spreadsheet formula protection. An incomplete snapshot must fail the operation instead of producing a successful truncated file.
3. Edit CLOB/BLOB cells and save. Read back exact content. Test empty values, NULL, multibyte text and binary values larger than one bind chunk. Concurrent changes must fail the old-value guard and retain the draft. Failed multi-statement writes must roll back; manual transactions must retain their existing ownership.
4. Start an asynchronous full-value copy, then change the focused cell. The original cell and column remain the copy target. Start another read, replace the result or dispose the grid while the backend remains pending, and reject the cancellation request. Local waiting must settle, late chunks must not modify either result, and a late HTTP preparation response must not start a download.
5. Close the result tab or disconnect one connection while a query is pending. Its result and client sessions must be released; other connections must remain usable. A late result must not restore the closed tab or its runtime state.
6. Hold the original session's registry, transaction or Agent lock, then cancel a LOB request. Core must finish local waiting and remove its task registration. Missing original pools, wrong client sessions and metadata-only pools must not create replacement locator sessions.
7. Render and export NULL date/time cells and explicit timezone values. NULL stays NULL; SQL extraction preserves the explicit timezone information.

## Automated coverage

- Frontend tests call the real editor, exporter, large-value composable, snapshot helpers and query/connection stores, with external backend calls controlled by fixtures.
- Agent tests cover chunk boundaries, retained locator lifetime, resource limits, typed BLOB bindings and RPC dispatch. Opt-in database tests must be reported as skipped when their environment is absent.
- Core tests cover snapshot export, original-session lookup and cancellation while waiting for locks. Transport tests cover late browser-download responses.
- Tests, type checking, compilation, database acceptance and GUI acceptance are separate evidence layers. Record the exact candidate and results in the PR.

## Limits and remaining acceptance

Local cancellation settles client waiting. It does not prove database-side statement termination or physical server cursor release. Native delivery may already have persisted its destination before cancellation reaches the caller; browser late-response checks do not establish atomic native-file cancellation.

The independent candidate still requires database and GUI readback against its own verified build. Historical integration-worktree results are not current-candidate acceptance. Exercise success, error, cancellation, close/reopen and disconnect with the loaded Agent JAR hash recorded. Verify exact fixture cleanup separately, and keep native delivery, clipboard content and untested database versions explicitly unverified until checked.
