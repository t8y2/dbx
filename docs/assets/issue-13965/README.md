# Issue #13965: file import refresh

These screenshots show a component integration fixture, using the production
`TableImportDialog`, `DataGrid`, `connectionStore`, and `queryStore`. The backend
API is simulated; no MariaDB server or desktop application is connected.
All names and rows are synthetic.

Environment: Chromium (Google Chrome), 1440 × 760, English, Vite on
`http://127.0.0.1:4195/`. Browser plugin not available; regular Playwright was used.

Flow: open the existing `demo.customers` data page → Import data → upload
`customers.csv` (`id,name` with Alice and Bob) → Next → Next → Start Import →
close the import dialog.

- `before.png`: the already-open grid contains zero rows.
- `after.png`: the same grid contains Alice and Bob, with an exact total of two.
  The import completed once and triggered one SELECT through the production
  query store, without clicking Refresh or reopening the table.

The fixture passed page identity, nonblank rendering, no framework error
overlay, no browser console/page errors, and interaction checks. It verifies the
frontend refresh chain only; real MariaDB, native file picking, and the desktop
runtime remain untested. Regression coverage lives in
`TableImportDialog.batchSelection.spec.ts` and `queryStore.tableDataRefresh.spec.ts`.
