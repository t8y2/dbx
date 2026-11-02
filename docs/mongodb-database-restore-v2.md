# MongoDB Database Restore: Lightweight Preview

The full-prevalidation/snapshot sections below are historical and superseded by
[Streaming Restore and Object Checks](mongodb-database-restore-streaming.md).
Metadata-first preview remains in use; restore no longer scans the backup twice.

Status: metadata-first restore flow implemented. This supersedes the restore preparation
flow in `mongodb-database-dump-restore.md`, not its dump formats or compatibility
boundary. Database export and collection import/export are unchanged.

## Implemented Scope

- Directory catalog requests contain only a bounded file manifest and metadata.
  Selected BSON files are uploaded after the user confirms the restore options.
- Desktop catalog discovery reads metadata/stat information without copying BSON.
  Archive catalog discovery stops after the prelude, without certifying payloads.
- Full validation now runs inside the confirmed restore task before target access
  or writes. Directory validation retains compressed inputs; archive validation
  writes only selected namespaces as compressed, multi-member BSON streams.
- Upload byte progress, validation byte/document progress, cancellation, source
  identity checks and a temporary disk free-space reserve are implemented.
- The existing upload environment setting is exposed to the frontend for prechecks;
  SQL and other table upload configurations are unchanged.

The broader lifecycle proposals below are not all part of this implementation:
there is no persistent task resume/background-task UI, abandoned-task startup
cleanup, or per-collection opt-out for unsupported metadata types yet. Unsupported
types retain the existing strict rejection policy. Directory upload is followed
by an explicit restore-start request, rather than a persistent upload/seal job.

## Problem

The current `prepare_mongodb_restore_source` uploads the entire directory,
decompresses and validates every BSON document, and writes an uncompressed
snapshot before presenting the source database and collection choices. The UI
waits for a single HTTP response without preparation progress or cancellation.

A 211-file gzip backup totaling 5,672,833,827 bytes exposed the problem: preparation
spent tens of minutes doing disk and CPU work before confirmation. Process I/O
counters confirmed continuing writes; directory file sizes on Windows did not
reliably reflect writes through still-open handles. No target database writes
occurred in that preparation phase.

## User Flow

1. Show the target connection/database immediately, prefilled from the tree node.
   Select directory/archive and gzip explicitly; do not infer or change options.
2. Read the backup catalog only. Populate source database, collection names,
   indexes/options availability, types and source file sizes. Unknown document
   counts stay unknown; do not scan BSON to obtain an exact count.
3. Choose one source database, target database and collections. Configure append
   or selected-collection replacement, options, indexes and write-error policy.
4. Confirm the frozen selection and destructive policy. Apply the existing
   production guard. Changing any choice requires a new confirmation.
5. Acquire the selected data, validate it, then restore. Show each phase separately.
   No target mutation is allowed before validation of the selected restore set
   completes successfully.

### Directory

- Web: enumerate `File` references and relative paths locally. Send a bounded file
  manifest plus `.metadata.json`/`.metadata.json.gz` contents for core parsing.
  Do not upload or read `.bson`/`.bson.gz` bodies before confirmation. Metadata
  uploads are also size-limited; gzip metadata has a decompressed size limit.
- Desktop: enumerate local paths and read metadata directly, without copying or
  decompressing collection data during preview.
- Missing optional metadata permits data-only restore with an explicit warning;
  names come from the existing official filename decoder. Reject ambiguous names,
  duplicate namespaces, unsafe paths, missing required BSON and option mismatch.
- After confirmation, Web uploads only the selected BSON and associated metadata.
  Validate the uploaded manifest against the confirmed catalog. Extra, missing,
  duplicate or changed metadata requires correction/review, not silent changes.
- Unselected directory collection data is not opened or validated. Unsupported
  collections can be displayed as unavailable without blocking unrelated supported
  selections. Unsafe source layout still rejects the source as a whole.

### Archive

- Web retains one full upload of the original archive in this iteration, with
  byte progress and cancellation. This transport cost happens before selection,
  but it does not include a full BSON scan or full archive extraction.
- Desktop reads only the local archive prelude during preview.
- Core reads magic, version and bounded collection metadata up to the prelude
  terminator, then stops. For gzip this decompresses only the prefix needed for
  the prelude. Preview does not certify archive EOF or gzip integrity.
- Collection data can be interleaved. After confirmation, validation must traverse
  the archive, including framing, namespace EOFs and checksums, even when only some
  collections are selected. Do not promise random access or selected-only reads
  for an archive. Restore only the selected namespaces.
- Whole-archive integrity errors still fail validation. Unsupported but unselected
  collection metadata need not fail an otherwise supported selection.

The archive layout above follows the checked-out official Database Tools 100.18.0
source, `common/archive/spec.md`: metadata is in the prelude, followed by interleaved
namespace segments and namespace EOF/checksum records.

## Source Ownership and Validation

Split the current single prepared-source concept into two internal states:

- `CatalogSource`: metadata, file manifest and source identity; not validated data.
- `ValidatedRestoreSource`: owned input plus validated selected namespaces/counts,
  bound to a frozen restore plan. Only this state may enter the write phase.

Keep opaque references on transports; do not accept arbitrary Web server paths.
Never let a catalog reference or client-provided `validated` flag bypass validation.
Cap catalog/session counts and metadata memory independently of BSON upload limits.

For directory input, retain an immutable snapshot in its original representation:
gzip stays gzip. Validate by streaming through it and discarding decoded bytes;
restore rereads the same owned snapshot. This intentionally trades a second gzip
decode for avoiding a potentially enormous uncompressed temporary copy. Reuse the
existing BSON importer and multi-member gzip support.

For archive input, validation may spool selected namespaces as compressed BSON
files for the existing collection importer. Use bounded buffers and bounded open
writers; complete gzip members per namespace segment allow interleaved namespaces
without an unbounded file-handle cache. Do not spool unselected namespaces or retain
an additional whole uncompressed archive. Finish all checks before using the spool.

Web owns uploaded inputs. Desktop acquires an owned snapshot after confirmation;
it must not validate a mutable original and later restore different bytes from it.
Check metadata/source identity against preview and fail/review changes. After
snapshot acquisition, validation and restoration use that same snapshot.

Before writes, recheck target writability, collection types, selected view
dependencies and the confirmed options. Missing dependencies must be resolved
explicitly or rejected; never silently add collections to the selection.
Corrupt BSON, gzip or archive framing is fatal regardless of the write-error policy.

## Job and Transport Contract

Use one restore task identity and freeze the plan at confirmation:

`catalog -> confirmed -> acquiring -> validating -> restoring -> indexes/views -> done`

Any active phase can become `failed` or `cancelled`. Target writes only start in
`restoring`. The metadata catalog endpoint stays bounded; it must not synchronously
wait for a full restore-source validation pass.

- Web catalog inspection accepts a directory manifest/metadata or an uploaded
  archive reference. Raw BSON is never treated as catalog metadata.
- Confirmation creates a task with the selected source, target and policies.
  Upload selected directory files into that task, then seal its input. Missing files
  or incomplete uploads prevent validation from starting.
- Repeated submit/seal requests for the same task cannot start a second restore.
- Reuse the existing replayable task progress transport. Reconnecting must recover
  the latest state and terminal result, not automatically re-execute writes.
- Cancellation is an explicit backend operation checked during upload, decode,
  validation, writes and index operations. Browser abort alone is not sufficient.
- Closing an active dialog offers cancel or continue in background. A transient
  connection loss does not silently cancel or retry database writes. Server restart
  interrupts a task; automatic mid-restore resume is outside this change.
- Adapt Web and Tauri to the same core plan/validation phases. Do not move MongoDB
  metadata parsing or restore policy into Vue or HTTP handlers.

Progress includes phase, current collection, collection counts, input bytes read,
validated uncompressed bytes, documents validated/restored and elapsed time.
Upload has a byte total; directory validation uses selected physical input size.
Archive scan progress uses the whole physical archive size, not selected sizes.
Do not compare compressed input totals to uncompressed output or display invented
overall percentages. Report partial writes on cancellation/failure; no rollback is
promised after the write phase begins.

## Resource Limits

- Reuse `DBX_MAX_UPLOAD_MB` for Web uploads. The current test service uses 8192 MiB;
  this design does not change the project default or SQL upload settings.
- Expose the effective upload limit for frontend checks before sending data. Apply
  it to the selected directory upload total or the whole archive, plus a separate
  bounded allowance for multipart framing. Enforce actual received bytes too and
  return structured HTTP 413 errors.
- Use server-owned `data_dir/tmp` storage for Web inputs and validation spools;
  avoid silently expanding large backups into a different OS temporary volume.
- Check available disk space before known-size acquisition and periodically while
  spooling. Keep an explicit free-space reserve and bounded decompression/metadata
  memory. Compressed file size and gzip trailer size are not safe expansion bounds.
- On failure, cancellation or expiry, remove only owned temporary data after active
  workers release it. Add startup cleanup for abandoned task directories. Never
  remove user originals, and do not change source ownership while a task is active.
- Desktop has no Web upload cap, but shares disk, format and cancellation checks.

## Code Boundaries

- `dbx-core/src/mongodb_dump/directory.rs`: separate metadata catalog discovery from
  selected input validation. No data reader calls during directory inspection.
- `dbx-core/src/mongodb_dump/archive.rs`: separate prelude inspection from full
  validation/demultiplexing; preserve official CRC and interleaving compatibility.
- `dbx-core/src/mongodb_dump.rs`: source states, frozen plans, acquisition ownership,
  preflight validation and restore phase transitions.
- Web routes/Tauri commands: file transport, task lifecycle, progress/cancel and
  limits. Keep existing export tasks and collection workflows unchanged.
- `MongoDatabaseDumpDialog.vue`: immediate target selection, lightweight catalog,
  confirmation and visible phase-specific progress. Format selection stays explicit.

## Implementation Order and Acceptance

1. Split catalog inspection from validation, with tests proving directory preview
   never reads BSON bodies and archive preview stops at the prelude terminator.
2. Introduce confirmed plans and selected acquisition/validation, avoiding whole
   uncompressed temporary snapshots. Validate all selected data before any drops.
3. Add Web metadata-first directory transport, task progress, cancellation, replay
   and upload prechecks. Connect the same phases to Tauri.
4. Update the dialog and run official-tool compatibility plus large-file tests.

Required regressions:

- 211-file directory preview sends only manifest/metadata; a huge BSON file does
  not increase preview work except for filename/size enumeration.
- Explicit gzip mismatch is reported before BSON upload when filenames identify it.
- Confirming a subset uploads/restores only that subset; confirm/drop never affects
  unselected target collections. Unknown counts remain unknown until validation.
- Corruption in the last selected collection fails before any target mutation.
- Interleaved archive and multi-member gzip still round-trip with official tools.
- Highly compressible input does not produce a whole uncompressed temporary copy;
  memory remains bounded and progress advances during validation.
- Cancel upload/validation, disconnect/reconnect, duplicate submit and disk-full
  cases do not leak workers or start unintended writes. Later write failures report
  partial completion honestly.
- Modified desktop inputs or changed uploaded metadata cannot invalidate the
  confirmed selection silently. SQL/table imports and database exports regress cleanly.

## Verification Results

- Eight core/integration tests passed, including official MongoDB Tools 100.18.0
  round trips for directory/archive with and without gzip, unchanged BSON values,
  options/indexes/views and rejection of corrupt data before selected-collection drops.
- Metadata-only directory preview accepts a 5 GiB manifest without BSON bodies;
  changed source files and mismatched confirmed uploads are rejected.
- A synthetic 211-file directory manifest representing 5 GiB sent 8,080 bytes of
  gzip metadata and returned 105 collections in 253 ms through the real HTTP route.
  This was not a benchmark of the user's original backup, which was unavailable.
- Twenty-eight focused frontend tests passed. A browser workflow against an
  isolated MongoDB instance previewed an official gzip directory, selected one
  collection, confirmed a different target database and restored two documents
  and two indexes. Desktop/mobile screenshots are under `output/playwright/metadata-v2-*`.
- Final Web HTTP integration, Vue type checking and Tauri compile checking passed.
  The main local Web service was restarted with `DBX_MAX_UPLOAD_MB=8192`.
