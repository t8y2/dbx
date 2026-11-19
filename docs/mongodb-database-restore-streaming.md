# MongoDB Streaming Restore and Object Checks

This supersedes the mandatory full-validation stage in
`mongodb-database-restore-v2.md`. Metadata-first previews remain unchanged.

## Official Reference

Compared against the locally checked-out MongoDB Database Tools 100.18.0 sources:

- `common/db/bson_stream.go`: reads BSON frames into byte buffers.
- `mongorestore/restore.go`: `LoadNext` feeds raw BSON to buffered insertion workers.
  When `objCheck` is enabled, the worker parses each document before inserting it.
- `mongorestore/mongorestore.go`: enables object checks when `--objcheck` is set.

Object checks are part of the single restore pass. They are not a separate full
backup scan. Server-side collection validators are a different concern and are
not disabled by this change.

## DBX Behavior

- Directory previews upload only the manifest and metadata. After confirmation,
  upload the selected data files. Web retains the existing upload limit setting.
- Archive previews read only the prelude after uploading the archive.
- Confirmed restoration checks source identity and metadata, then reads, decompresses
  and inserts data in one pass. Local desktop inputs are read directly; Web inputs
  remain owned uploads held alive until the restore reader finishes.
- Restore data uses the existing official Rust BSON library's `RawDocumentBuf`
  and the existing MongoDB driver's insert helper, generalized for serializable
  BSON values. Raw bytes are not converted through JSON or an owned Document by default.
- `objcheck` is an optional boolean, default false. If enabled, the same official
  BSON library parses each selected document in the reader before it enters the
  insertion queue. The original bytes, not the decoded/re-encoded object, are inserted.
- A bounded two-batch queue connects blocking file/decoder work to asynchronous
  writes. Each batch is capped by document count and an 8 MiB byte target; a single
  valid BSON document may exceed that target up to the existing document-size cap.
- Archive namespace segments are demultiplexed directly into this queue, including
  interleaved namespaces. There is no archive extraction/recompression/spool pass.
- Frame boundaries, truncation, gzip integrity and archive namespace EOF/CRC checks
  remain mandatory while reading. They are not controlled by `objcheck`.
- Indexes and dependency-ordered views are restored after the data stream completes.
- Stream errors terminate the task and preserve partial write counts. Data preceding
  a late error may already be restored; this no longer promises prevalidation before
  selected-collection replacement. No rollback or automatic retry of the whole task.
- Cancellation closes the bounded queue, signals the reader and joins it. Progress
  includes decoded bytes read even while skipping unselected archive namespaces.

## Ownership

- `mongodb_dump/source.rs`: catalog references, upload binding and file identity checks.
- `mongodb_dump/archive.rs`: official framing and streaming namespace/CRC handling.
- `mongodb_dump/stream.rs`: bounded raw BSON batches, optional SDK object checks and
  lifecycle coordination with the native MongoDB insert helper.
- `mongodb_dump.rs`: metadata preflight, selected target initialization, indexes,
  views and task summaries.
- Web/Tauri transport: unchanged restore command with the additional `objcheck` flag.
- Dialog: one optional object-check checkbox, default off. No additional warning,
  prevalidation toggle or confirmation step is introduced.
- The execution entry is locked before awaiting production confirmation. A late
  confirmation after dialog disposal cannot start a task. View dependency sorting
  uses an explicit stack, so deep metadata chains cannot overflow the call stack.

## Verification

Focused tests cover default-off and enabled object checks, exact raw BSON bytes,
metadata-only previews, partial restore on late corruption, gzip/archive integrity,
official-tool round trips, read-only mode and cancellation. An opt-in compressed
parser throughput smoke test compares raw streaming, streaming with object checks
and the former double-parse pattern without database/network overhead.

### Local Results (2026-09-15)

- 7 focused core tests passed, including the opt-in parser benchmark and ordering
  a 20,000-entry dependency chain without recursion.
- 8 integration tests passed against isolated MongoDB 8.0.17 and Database Tools
  100.18.0. Directory/archive, with and without gzip, round-tripped in both
  directions with matching BSON, collection options, indexes and views.
- Cancellation stopped after the first 100-document batch of a 201-document
  fixture. Duplicate-key tests verified partial success counts and stop/continue
  behavior. Late BSON corruption, archive CRC failure and truncation preserved
  partial write counts instead of requiring an initial full scan.
- Collection-level BSON and gzip regressions each round-tripped 1,207 documents
  through official tools with matching BSON bytes.
- 32 frontend tests and Vue type checking passed, including double-submit,
  disposed-dialog confirmation and declined-confirmation regressions. The Web
  backend build and HTTP upload/progress smoke test also passed.

Parser-only smoke test: Windows x64, unoptimized Rust test build, an in-memory
gzip fixture containing 8,192 documents (27.56 MiB decoded, 64 string fields per
document). The old pattern is simulated by two object-parsing passes, not by
running an older DBX binary.

| Path | Passes | Elapsed |
| --- | --- | --- |
| Raw streaming, default | 1 | 129 ms |
| Streaming with object checks | 1 | 851 ms |
| Simulated former double parse | 2 | 2,315 ms |

These figures exclude upload, disk I/O, MongoDB writes and index building. They
are not an end-to-end restore speed guarantee; the user's 5.28 GiB backup has not
been benchmarked with this implementation.

No active user task or configured data source was used by these tests.

## Duplicate Keys

Restore inserts documents; it does not upsert or overwrite matching IDs. Without
`dropExisting`, existing target documents (including prior partial restores) may
cause `E11000`. Object checks do not disable server-side unique indexes. With
`dropExisting`, only selected target collections are deleted and recreated.
The confirmation-entry race was reproduced and fixed, but that alone does not
identify the cause of a particular duplicate-key report.
