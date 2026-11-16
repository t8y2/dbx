# MongoDB Database Dump and Restore

Restore preparation is superseded by [Lightweight Preview](mongodb-database-restore-v2.md)
and [Streaming Restore](mongodb-database-restore-streaming.md): catalog discovery
reads metadata only, and data is checked while restoring, without a separate full
validation pass. The verification history below describes earlier implementations.

## Goal and Formats

Add database-scoped dump/restore to the existing MongoDB database tree node. Keep
the collection data workflow added in f21a47725 and reuse its BSON import/export.

Support the official Database Tools 100.18.0 formats:

- Directory: `<database>/<escaped-collection>.bson` and `.metadata.json`.
- Gzip directory: `.bson.gz` and `.metadata.json.gz`.
- Official `mongodump --archive` format 0.1, optionally gzip compressed.

Archive is the single-file transport for Web downloads. It is not a ZIP file.
Web restores accept an archive or a selected dump directory; desktop exports and
restores support both formats. Format and gzip are explicit user options.

References:

- https://www.mongodb.com/docs/database-tools/mongodump/
- https://www.mongodb.com/docs/database-tools/mongorestore/
- https://github.com/mongodb/mongo-tools/blob/100.18.0/common/archive/spec.md
- Official source: `common/archive`, `mongodump/metadata_dump.go`,
  `mongodump/prepare.go`, `mongorestore/metadata.go`, `mongorestore/restore.go`.

## Ownership

- `dbx-core::mongodb_dump`: metadata, source preparation, database plans, progress,
  cancellation, collection options, indexes and views.
- `dbx-core::mongodb_dump::archive`: official prelude, namespace segments,
  terminators and per-namespace CRC64 validation. BSON and gzip use the existing
  libraries; CRC uses a maintained implementation, not handwritten arithmetic.
- Existing `mongodb_import_export`: bounded BSON streaming and batched inserts.
- Web routes and Tauri commands: transport, writable-connection checks, task
  notifications and source/download cleanup. No database logic in adapters.
- `MongoDatabaseDumpDialog`: source/destination, collection selection, restore
  policy, confirmation, progress and cancellation.

## Export

1. Resolve the native MongoDB connection and list collection specifications.
2. Collect canonical Extended JSON metadata including options, index key order,
   index options and collection type. Views have metadata but no BSON data file.
3. Dump each regular collection, including empty collections, into a private
   temporary directory using the existing BSON exporter.
4. Publish the directory or stream it into an official archive. Archives include
   the official header and CRC64 checksums over the original BSON bytes.
5. Publish only after success. Cancellation or errors discard temporary output.

## Restore

1. Explicitly select directory/archive and gzip. Directory preview sends a manifest
   and metadata only; archive preview reads the prelude of the uploaded archive.
2. Select one source database and a target database; select all or some collections.
3. Confirm the selection and policies, then acquire the selected data. Uploads stay within owned staging
   directories. Reject links, unsafe paths, duplicate namespaces, malformed BSON,
   corrupt gzip, unsupported archive versions and CRC mismatches.
   Use the same owned input for validation and restoration. Validate all selected
   directory BSON files or full archive framing/checksums before any target writes.
   Exact document counts are unknown during preview and populated during validation.
4. Default to appending documents. `dropExisting` applies only to selected target
   collections, never to the whole target database. Enforce readonly and existing
   production-execution guards in both transports/UI.
5. Create missing collections with saved options when enabled; existing collections
   retain their options unless explicitly dropped. Never preserve source UUIDs or
   issue `applyOps`. Strip obsolete index version/namespace fields before creating
   indexes; let collection creation establish its automatic `_id` index.
6. Import documents through the existing batched BSON importer, then restore indexes.
   Restore views in dependency order after their backing collections.
7. Report partial counts on failure/cancellation. Completed writes are not rolled
   back. Releasing a source cannot delete data still owned by an active task.

## Initial Compatibility Boundary

This change covers ordinary, capped and clustered collections, GridFS collections,
validators, collations, index definitions and views. It is not a replica-set
snapshot: concurrent writes follow the normal no-oplog dump behavior.

Time-series/raw bucket restoration, Queryable Encryption, oplog replay, UUID
preservation and user/role migration require separate server-specific handling.
Reject unsupported collection types/options before writing; do not silently omit
them. Internal admin/config/local databases are outside this user-database workflow.
Ordinary user databases skip internal `system.*` collections except `system.js`.

## Verification

- Unit tests: canonical metadata, escaped names, archive CRC/EOF/interleaving,
  corrupt/truncated input, unsafe directory entries, view dependencies.
- Official tool tests on an isolated MongoDB server: multiple collections, an empty
  collection, capped/validated collections, compound/unique/TTL indexes and views;
  both directions for directory/archive, plain/gzip, with BSON and metadata checks.
- Restore policies: append, selected-collection drop, unselected target preservation,
  optional indexes/options, cancellation and readonly rejection.
- Web tests: multipart paths, source ownership, delayed progress subscription and
  streaming downloads. Frontend tests: database menu, explicit format/options,
  confirmation and backend dispatch. Inspect the running Web UI before delivery.

## Implementation Order

1. Core metadata/source plan and official archive codec.
2. Database export/restore orchestration and focused integration tests.
3. Web/Tauri adapters and lifecycle handling.
4. Database menu/dialog, localization and frontend tests.
5. Official tool round trips, UI inspection and final review.

## Verified Results

Verified against MongoDB Server 8.0.17 and Database Tools 100.18.0 on Windows:

- Both directions for all four combinations: directory/archive, plain/gzip.
- Six collections/views, including an empty collection, capped data, an escaped
  collection name, a validator and collation, compound unique and TTL indexes,
  and a view that depends on another view. BSON data and collection/index options
  match the source after each restore.
- Selected-collection drop preserves unselected target data; disabling options
  and indexes works; readonly and cancellation checks reject writes; prepared
  changed original inputs are rejected and restore uses an owned input snapshot.
- Invalid metadata, cyclic views, truncated archives and bad archive CRC are rejected.
- The HTTP test launches the real Web binary and verifies multipart path rejection,
  directory preparation, source release and replay of late task notifications.
- Desktop and Web compile checks, frontend type checking, focused UI tests and
  desktop/mobile Playwright inspection completed. Screenshots are in
  `output/playwright/database-{dump,restore}-desktop.png` and
  `output/playwright/database-restore-mobile.png`.

The opt-in database test is `official_database_tools_round_trip_through_dbx` in
`crates/dbx-core/tests/mongodb_dump_restore.rs`. Set `DBX_MONGO_DUMP_TEST_URI` and
`DBX_MONGO_TOOLS_DIR` to run it against an isolated server.
