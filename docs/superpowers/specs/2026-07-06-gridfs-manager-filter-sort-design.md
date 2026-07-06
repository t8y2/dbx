# GridFS Manager Filter And Sort Design

**Date:** 2026-07-06

## Goal

Extend the existing GridFS manager and bucket browser so MongoDB users can filter and sort GridFS data without leaving the dedicated GridFS workflow.

This work covers three user-facing improvements:

- add query-style filter and sort controls to the GridFS file list
- add filter and sort controls to the GridFS bucket manager
- make the GridFS sidebar node more visually distinct from regular Mongo collections

## Background

The dedicated GridFS browser shipped on 2026-07-03 and already provides:

- a single `GridFS` sidebar entry per Mongo database
- a database-level manager page for bucket CRUD
- a bucket-level file browser for upload, download, and delete

Issue #2589 reports that the new Mongo manager flow still lacks filtering. The current UI shows static tables only:

- `MongoGridFsBrowser.vue` lists bucket summaries with no filter or sort controls
- `MongoBucketBrowser.vue` lists bucket files with a fixed default ordering
- the backend `list_gridfs_files` API always runs an empty `find({})` with a built-in descending upload date sort

The goal of this iteration is to keep the dedicated GridFS UX, but make it feel closer to the existing Mongo document query experience.

## Current State

### File browser

`MongoBucketBrowser.vue` currently:

- loads every file in the selected bucket
- shows a table with metadata columns
- supports upload, download, delete, refresh
- has no filter input
- has no user-controlled sort
- has no query preview

### Bucket manager

`MongoGridFsBrowser.vue` currently:

- loads every GridFS bucket summary for the database
- shows bucket name, file count, and total size
- supports create, delete, open, refresh
- has no filter input
- has no user-controlled sort

### Sidebar

`TreeItem.vue` currently renders:

- `mongo-gridfs` and `mongo-buckets` with `Archive` plus amber styling
- `mongo-bucket` with a very similar `Archive` plus lighter amber styling

This makes the GridFS entry readable, but not especially distinct from other MongoDB tree nodes.

## Requirements

### Functional

- users can filter GridFS files within a bucket
- users can sort GridFS files within a bucket
- users can filter GridFS buckets within a database
- users can sort GridFS buckets within a database
- file-list sorting works both from explicit sort input and column-header sort actions
- the GridFS sidebar entry has a clearer dedicated visual treatment

### Behavioral

- existing upload, download, delete, create, and open flows keep working
- existing callers that omit new query parameters retain current behavior
- invalid filter or sort input produces visible errors rather than silent fallback

## Chosen Approach

### Query model

Use one consistent principle across both GridFS pages:

- execute filter and sort on the server
- keep frontend controls visually aligned with the document query UI
- only reuse document-query semantics where the underlying data shape supports it cleanly

### Bucket file browser

The file browser should closely mirror Mongo document query behavior.

Frontend:

- add `filter` and `sort` text inputs to `MongoBucketBrowser.vue`
- show a query preview string for the effective GridFS file query
- trigger reload on Enter, refresh click, and table-header sort changes
- map header sort actions back into the `sort` input, matching `DocumentBrowser.vue`

Backend:

- extend the GridFS file list API to accept optional `filter` and `sort` strings
- parse them with the same Mongo document parsing helpers already used by document queries
- run the query against `<bucket>.files` as `find(filter).sort(sort)`
- preserve the existing default sort of `uploadDate desc, _id desc` when no sort is provided

Preview format:

- use `db.getCollection("<bucket>.files").find(...).sort(...).skip(0).limit(...)` style output
- the preview exists for transparency and consistency, even if the file browser continues returning a plain row list instead of a paged document result object

### Bucket manager

The bucket manager should adopt the same interaction style, but not pretend bucket summaries are raw Mongo documents.

Frontend:

- add a lightweight `filter` input for bucket-name matching
- add a sort control that behaves like the existing query toolbar and table-header sorting
- keep the manager table focused on `name`, `fileCount`, and `totalBytes`

Backend:

- extend the bucket list API to accept optional filter and sort parameters
- filter bucket summaries by normalized bucket name match
- sort bucket summaries by one of:
  - `name`
  - `fileCount`
  - `totalBytes`
- default to `name asc` when no explicit sort is provided

This gives the manager page service-side filtering and sorting while staying honest about the underlying data model, which is aggregated summary data rather than a directly queried collection.

### Sidebar icon treatment

Keep the existing icon family but make the top-level GridFS entry visually stand apart.

- `mongo-gridfs`: keep `Archive` but switch to a more distinctive cool color so it no longer blends with ordinary Mongo tree items
- `mongo-bucket`: keep the same icon family with a related but softer shade

The goal is recognition, not a broad tree redesign.

## Architecture

### Backend layers

Update the GridFS query path across all transport layers:

- `crates/dbx-core/src/db/mongo_driver.rs`
- `crates/dbx-core/src/document_ops.rs`
- `src-tauri/src/commands/document_cmd.rs`
- `crates/dbx-web/src/routes/document_store.rs`
- `apps/desktop/src/lib/backend/tauri.ts`
- `apps/desktop/src/lib/backend/http.ts`

The backend remains backward compatible by treating all new parameters as optional.

### Frontend layers

Update the dedicated GridFS views:

- `apps/desktop/src/components/document/MongoBucketBrowser.vue`
- `apps/desktop/src/components/document/MongoGridFsBrowser.vue`

Reuse document-query support where it fits:

- `apps/desktop/src/lib/app/documentStoreProvider.ts`

Update the sidebar presentation in:

- `apps/desktop/src/components/sidebar/TreeItem.vue`

## Data Flow

### File browser

1. User opens a GridFS bucket tab.
2. `MongoBucketBrowser.vue` builds the current `filter` and `sort` state.
3. Frontend sends the new parameters through the shared document-store API.
4. Rust applies the filter and sort to `<bucket>.files`.
5. The returned file list renders in the table and side detail panel.
6. If the user clicks a sortable header, the UI rewrites the `sort` input and reloads.

### Bucket manager

1. User opens the `GridFS` manager tab.
2. `MongoGridFsBrowser.vue` sends current manager filter and sort state.
3. Rust collects bucket summaries, filters them, sorts them, and returns the list.
4. The manager table and summary pane update in place.

## Error Handling

- invalid Mongo-style file filter input should surface as a visible page error
- invalid file sort input should surface as a visible page error
- unsupported bucket-manager sort fields should return a clear backend error
- empty filter input should behave like no filter
- missing sort input should fall back to the page default sort
- write operations continue to use the existing read-only safeguards

## Testing

### Frontend

Add or update Vitest coverage for:

- GridFS query preview formatting in `documentStoreProvider`
- request assembly for GridFS file filter and sort loading
- request assembly for GridFS bucket filter and sort loading
- sidebar icon and color mapping for `mongo-gridfs` and `mongo-bucket`

### Backend

Add Rust coverage for:

- GridFS file filter parsing
- default file sort fallback
- explicit file sort handling
- bucket summary filtering
- bucket summary sorting by supported fields

## Scope Boundaries

### Included now

- service-side GridFS file filtering
- service-side GridFS file sorting
- service-side GridFS bucket filtering
- service-side GridFS bucket sorting
- query-style toolbar inputs for the file browser
- visually improved GridFS sidebar node styling

### Not included now

- pagination contract changes for GridFS APIs
- turning bucket summaries into full Mongo document queries
- advanced bucket filter builders
- drag-and-drop upload improvements
- inline file editing or file preview

## Success Criteria

- users can narrow GridFS files with Mongo-style filter input
- users can sort GridFS files from either toolbar input or table headers
- users can narrow and sort GridFS bucket summaries from the manager page
- the dedicated GridFS sidebar node is easier to distinguish at a glance
- existing GridFS CRUD flows keep working without regression
