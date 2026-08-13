# Database documentation in DBX — design

**Part 3b of the database-documentation feature.** Parts 1, 2 and 3a are complete and merged into
`feature/docs-snapshot-dbml`: `SchemaSnapshot` collection with a DBML serializer and a `dbx dbml`
verb, a file-backed annotation store for notes and table groups, and a read-only Vue viewer tested
against a real backend-generated fixture.

This part makes the viewer reachable and editable inside DBX. The standalone HTML export, the
`dbx docs` verb and hash routing are deliberately **not** here — they are Part 3c.

## Goal

A user opens a connection's documentation from the tree, reads a dbdocs.io-style wiki of their
schema, and edits it in place: table and column notes, table groups, and each group's colour.
Everything they write persists to a JSON notes file that can live inside their repository.

## Scope

**In scope**

- `DatabaseDocsDialog.vue`, mounted through the existing dialog pattern
- Backend reachability: the desktop frontend currently cannot call the docs collector at all
- Editing: table notes, column notes, project note, group create/rename/delete/assign, group hue
- Debounced autosave to the notes file, with a visible saved/failed indicator
- `EnumPage.vue`
- An i18n `docs` namespace across all 8 locales, with a parity guard
- A link from the docs viewer to the existing `SchemaDiagramDialog`

**Out of scope (Part 3c)**

- The standalone Vite bundle and self-contained HTML export
- The `dbx docs` CLI verb
- Hash routing (`#/table/public.orders`) — its purpose is surviving a `file://` load
- A minimal read-only ER renderer for the export
- Inlining the Geist woff2 at `apps/desktop/public/fonts/geist-latin-wght-normal.woff2`

**Explicitly not built**: a second ER diagram. DBX already ships `SchemaDiagramDialog.vue`
(51.6 KB) with custom relationships, join-SQL generation and zoom. In-app, the docs viewer links
to it. Only the export needs its own minimal renderer, because that dialog reaches into stores and
the backend and therefore cannot be inlined.

## Architecture

### The viewer stays pure; the dialog owns all I/O

Part 3a's contract test forbids `apps/desktop/src/docs/**/*.vue` from referencing `@/lib/backend`,
`@tauri-apps`, `invoke(`, `fetch(`, or any store. Editing preserves that rule: components emit
edit intents upward, and only `DatabaseDocsDialog.vue` — which lives outside `src/docs/` — talks to
the backend.

This is not ceremony. It is what allows Part 3c to bundle the identical components into an HTML
file that runs on a machine with no DBX installed.

```
connectionStore.docsSource              set by the connection-tree context menu
  → useDialogSources.ts watcher         mirrors the existing diagramSource pattern
  → showDocsDialog + prefills
  → DatabaseDocsDialog.vue              owns: collect, load notes, save notes, autosave
       │  props: snapshot, annotations  ↓ emits: update:note, update:group, …
       └─ DocsApp.vue                   Part 3a, unchanged apart from readonly=false
```

### Four backend operations, five touchpoints each

`apps/desktop/src/lib/backend/api.ts` is a facade that lazily resolves either `tauri.ts` or
`http.ts` via `isTauriRuntime()` and re-exports each function through `forward()`. Every operation
therefore exists twice, once per transport. There is currently **no docs entry in `api.ts` at
all** — Part 1's collector is reachable from the CLI, MCP and the web route, but never from the
desktop frontend.

| Operation | Returns | Existing | New |
|---|---|---|---|
| `collectDocsSnapshot` | raw `SchemaSnapshot` | web route | Tauri command, both transports, `api.ts` forward |
| `loadDocsAnnotations` | `AnnotationFile \| null` | `load_annotations` | path resolution, command, routes, forward |
| `applyDocsAnnotations` | applied `SchemaSnapshot` | `apply_annotations` | command, routes, forward |
| `saveDocsAnnotations` | `()` | — | **`save_annotations` does not exist** |

### Why `applyDocsAnnotations` is a separate call

The viewer renders a snapshot with annotations already applied, but edits target the
`AnnotationFile`. After an edit the displayed snapshot is stale.

Applying the edit optimistically in TypeScript would mean reimplementing `apply_annotations`,
including the `shadowedNote` rule where a local note displaces a database `COMMENT ON` and
preserves it underneath. A second implementation of that rule in a second language is exactly the
drift this feature has repeatedly suffered from.

Instead, `collect` returns the **raw** snapshot, and `applyDocsAnnotations(raw, file)` is a pure
Rust call with no database access. The dialog keeps the raw snapshot from open and re-derives on
demand. One implementation of the rule, in the language where it is already tested.

While the user types, nothing is re-derived: the editor binds to the raw note text in the
`AnnotationFile`, not to rendered output. The round trip happens on blur, not per keystroke.

### Notes file location

`config.docs_notes_path` when set; otherwise `<app_data>/docs-notes/<connection_id>.json`.

The default makes the feature work with no setup. The override is the point: pointing it at a file
inside a repository is what lets schema documentation be code-reviewed and committed alongside the
schema it describes.

`docs_notes_path` already exists on `ConnectionConfig`, `ConnectionConfigData` and the `From` impl
(Part 2). Nothing reads it yet.

### `save_annotations` must be atomic

Write to a temporary file in the same directory, fsync, then rename. A partial write destroys prose
a human typed, and `load_annotations` errors loudly on malformed JSON — so a torn write becomes
"your notes file is corrupt" the next time the dialog opens.

A failed save must surface in the UI. A silently swallowed write failure is the worst outcome this
feature can produce.

## Editing

### Edits are pure transformations of the `AnnotationFile`

`apps/desktop/src/docs/annotationEdits.ts` — every function takes an `AnnotationFile` and returns a
new one, with no I/O:

- `setProjectNote(file, note)`
- `setTableNote(file, tableKey, note)`
- `setColumnNote(file, tableKey, column, note)`
- `setTableGroup(file, tableKey, groupId | null)`
- `upsertGroup(file, group)` — create or update name, hue, note
- `removeGroup(file, groupId)` — also clears the reference from every table that used it

Empty or whitespace-only notes remove the entry rather than storing an empty string, so the file
does not accumulate dead keys.

**Deleting a group clears its references.** `docsIndex.ts` already drops a dangling `groupId` when
rendering, so the viewer degrades correctly either way — but the file should not carry references
to a group that no longer exists.

### Components

All thin; every decision lives in `annotationEdits.ts` or an existing Part 3a module.

- **`NoteEditor.vue`** — renders `renderNote(...)` output until clicked, then swaps to a raw
  markdown textarea. Reused for table, column, group and project notes. The `v-html` contract rule
  applies here as everywhere: only `renderNote` output may be bound.
- **`GroupEditor.vue`** — name field plus the hue picker from the approved mock: 12 swatches, a
  360° slider, and a preview showing the colour on light and dark grounds simultaneously. The
  two-ground preview is why the hue-only model exists, so it belongs in front of the user while
  they choose.
- **`GroupPicker.vue`** — assigns a table to a group; a select plus "New group…".
- **`EnumPage.vue`** — a `DocEnum`'s values, its note, and the columns using it. The reverse lookup
  from enum to using columns is a tested function in `docsIndex.ts`, not template logic.

### `readonly` returns

Part 3a removed the `readonly` prop as YAGNI, since nothing read it. Part 3b reintroduces it
because Part 3c renders the identical components with editing disabled.

### Autosave

Debounced ~500 ms after the last edit, owned by the dialog. A small indicator shows saved / saving
/ failed. Failure is visible and the in-memory state is retained so the user can retry rather than
losing what they wrote.

## i18n

A `docs` namespace added to all 8 locales: `en`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-CN`, `zh-TW`.

`withEnglishFallback` deep-merges `en` underneath every locale, so a key missing from `ja.ts`
silently renders English with no error, no warning, and no failing test. Translation completeness
is therefore unobservable at runtime.

**A key-parity test is required**: import the raw locale modules — not the merged output — and
assert every locale declares the same key set under `docs` as `en` does. Scoped to the new
namespace only; parity across the existing 315 KB of keys is out of scope and would fail
immediately.

Part 3a hardcoded English strings in `docsWarnings.ts`. Those move into the namespace, which is a
breaking change to that module: `describeWarning(warning)` becomes
`describeWarning(warning, translate)`, and its existing tests change with it.

It takes a **translator function** rather than importing `useI18n` directly, and that is
deliberate. `useI18n()` throws without a provided instance, which is exactly the Part 3c
standalone-export case — a bare HTML file with no Vue app bootstrapped around it. Passing the
translator in keeps `docsWarnings.ts` a pure module the export can call with an English identity
function. Importing vue-i18n inside `src/docs/` would make the export impossible.

## Testing

| Layer | Approach |
|---|---|
| `annotationEdits.ts` | Pure unit tests — the bulk of the coverage |
| `save_annotations` | Rust: atomicity; a failed write leaves the previous file intact |
| Path resolution | Rust: override wins; default when unset |
| Components | The Part 3a static SFC contract test, extended to the new files |
| i18n | Key parity across 8 locales for the `docs` namespace |
| Dialog | Autosave debounce; the failure indicator |

**Every new test gets the deliberate-break treatment**: break the behaviour, watch the named test
fail, restore, report the failure message. In Part 3a this caught a vacuous ranking test, a CSS
ordering bug that let a whole theme's colours be deleted silently, and a capability warning that
contradicted its own data. It is the highest-yield practice carried forward.

### Known gap: `DocEnum` drift is unguarded

The conformance fixture is generated from `keycloak`, which declares no PostgreSQL enum types, so
`snapshot.enums` is empty and `DocEnum` field renames are not detectable. `EnumPage` tests use
in-memory snapshots, which prove the rendering logic but not the Rust↔TS boundary.

`fixtureConformance.spec.ts` carries a self-correcting assertion that fails the day the fixture
source gains an enum, with the exact `pinShape` call to restore. Part 3c is the natural time to
close this, since an exportable demo wants an enum-bearing schema anyway.

## Success criteria

- A user opens documentation from the connection tree, reads it, edits notes and group colours, and
  the changes survive closing and reopening the dialog.
- Pointing `docs_notes_path` at a repository file produces a diff a colleague can review.
- `apps/desktop/src/docs/**/*.vue` still makes zero backend calls, enforced by the contract test.
- All 8 locales declare the same `docs` keys, enforced by a test.
- A failed save is visible to the user and does not discard their work.
