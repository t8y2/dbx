# In-App Database Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Part 3a documentation viewer reachable from inside DBX and editable — table and column notes, table groups, and per-group colour — autosaved to a notes file that can live in the user's repository.

**Architecture:** The viewer components stay pure (snapshot in, DOM out, zero backend calls, enforced by an existing contract test) so Part 3c can bundle them into a standalone HTML file. `DatabaseDocsDialog.vue` sits outside `src/docs/` and owns all I/O. Edits are pure transformations of the `AnnotationFile`, applied by Rust so the `shadowedNote` rule has exactly one implementation.

**Tech Stack:** Rust (`dbx-core`, `dbx-web`, `src-tauri`), Vue 3 `<script setup lang="ts">`, Tailwind, vitest, vue-tsc, oxlint.

## Global Constraints

- **`apps/desktop/src/docs/**/*.vue` must make ZERO backend calls.** `componentContract.spec.ts` forbids `@/lib/backend`, `@tauri-apps`, `invoke(`, `useConnectionStore`, `useQueryStore`, `useSettingsStore`, `fetch(`, `axios`, `innerHTML`, `oklch(`, six-digit hex literals, and any `v-html` binding (either quote style) not naming `renderNote`. Extend that test; never weaken it.
- **Never import `vue-i18n` inside `apps/desktop/src/docs/`.** `useI18n()` throws without a provided instance, which is exactly the Part 3c standalone-export case. Modules there take a translator function as a parameter instead.
- **Every backend operation exists twice.** `apps/desktop/src/lib/backend/api.ts` resolves either `tauri.ts` or `http.ts` via `isTauriRuntime()`. Both must be implemented, plus a Tauri command and a web route.
- **All annotation structs carry `#[serde(rename_all = "camelCase", deny_unknown_fields)]`.** An extra key sent from TypeScript is a hard deserialization error, not a silent ignore. `format_version` serialises as `formatVersion`.
- **`dbx-core` must not depend on `dbx-mcp`.** `app_data_dir()` lives in `dbx-mcp`, so anything in `dbx-core` needing it takes the directory as a parameter.
- **Rust commands:** `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"` before `cargo` or `git commit` (the pre-commit hook runs `cargo fmt`). Use `pnpm`, never `npm`.
- **Every new test gets a deliberate break:** break the behaviour, watch the named test fail, restore, report the failure message. A test that cannot fail is worse than no test.
- Baseline before this plan: 77 frontend tests, 4428 Rust tests, `vue-tsc` exit 0, `oxlint` clean.

---

## File Structure

**Rust — `dbx-core`**
- `crates/dbx-core/src/docs/annotations.rs` — add `save_annotations`, `resolve_notes_path`

**Rust — Tauri**
- `src-tauri/src/commands/docs.rs` — CREATE: four commands
- `src-tauri/src/commands/mod.rs` — declare the module
- `src-tauri/src/lib.rs:1411` — register in `generate_handler!`

**Rust — web parity**
- `crates/dbx-web/src/routes/docs.rs` — add three handlers
- `crates/dbx-web/src/main.rs:377` — register three routes

**Frontend — data and logic**
- `apps/desktop/src/docs/types.ts` — add annotation types
- `apps/desktop/src/docs/annotationEdits.ts` — CREATE: pure edit transforms
- `apps/desktop/src/docs/docsIndex.ts` — add `columnsUsingEnum`
- `apps/desktop/src/docs/docsWarnings.ts` — take a translator parameter

**Frontend — backend facade**
- `apps/desktop/src/lib/backend/tauri.ts`, `http.ts`, `api.ts` — four operations each

**Frontend — components**
- `apps/desktop/src/docs/components/NoteEditor.vue`, `GroupEditor.vue`, `GroupPicker.vue`, `EnumPage.vue` — CREATE
- `apps/desktop/src/docs/DocsApp.vue` — `readonly` prop, edit events
- `apps/desktop/src/components/docs/DatabaseDocsDialog.vue` — CREATE: owns I/O and autosave

**Frontend — wiring and i18n**
- `apps/desktop/src/stores/connectionStore.ts` — `docsSource`
- `apps/desktop/src/composables/useDialogSources.ts` — watcher
- `apps/desktop/src/components/layout/AppDialogs.vue` — registration
- `apps/desktop/src/i18n/locales/{en,es,it,ja,ko,pt-BR,zh-CN,zh-TW}.ts` — `docs` namespace
- `apps/desktop/src/i18n/__tests__/docsNamespaceParity.spec.ts` — CREATE

---

## Task 1: Atomic save and notes-path resolution

**Files:**
- Modify: `crates/dbx-core/src/docs/annotations.rs`
- Test: same file's `mod tests`

**Interfaces:**
- Consumes: `AnnotationFile` (existing), `ConnectionConfig` (existing, `docs_notes_path: Option<String>`)
- Produces: `save_annotations(path: &Path, annotations: &AnnotationFile) -> Result<(), String>`, `resolve_notes_path(connection_id: &str, docs_notes_path: Option<&str>, data_dir: &Path) -> PathBuf`

- [x] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `annotations.rs`:

```rust
    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_case_dir("round-trip");
        let path = dir.join("notes.json");
        let file = AnnotationFile {
            format_version: 1,
            project: Some(ProjectAnnotation { name: Some("P".into()), note: Some("hello".into()) }),
            groups: vec![GroupAnnotation { id: "g".into(), name: "G".into(), hue: 200, note: None }],
            tables: BTreeMap::from([(
                "public.t".to_string(),
                TableAnnotation { group: Some("g".into()), note: Some("n".into()), columns: BTreeMap::new() },
            )]),
        };

        save_annotations(&path, &file).expect("save");
        let loaded = load_annotations(&path).expect("load").expect("present");

        assert_eq!(loaded.format_version, 1);
        assert_eq!(loaded.groups[0].hue, 200);
        assert_eq!(loaded.tables["public.t"].note.as_deref(), Some("n"));
        assert_eq!(loaded.project.and_then(|p| p.note).as_deref(), Some("hello"));
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = temp_case_dir("nested");
        let path = dir.join("nested").join("deeper").join("notes.json");
        let file = AnnotationFile {
            format_version: 1,
            project: None,
            groups: Vec::new(),
            tables: BTreeMap::new(),
        };
        save_annotations(&path, &file).expect("save into a new directory");
        assert!(path.exists());
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        // A stray notes.json.tmp would be picked up by nothing, but it means
        // the rename did not happen and the write was not atomic.
        let dir = temp_case_dir("no-temp-left");
        let path = dir.join("notes.json");
        let file = AnnotationFile {
            format_version: 1,
            project: None,
            groups: Vec::new(),
            tables: BTreeMap::new(),
        };
        save_annotations(&path, &file).expect("save");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read_dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[test]
    fn a_failed_save_leaves_the_previous_file_intact() {
        // The reason for writing to a temp file and renaming. If the write
        // fails partway, the reader must still find the last good notes —
        // load_annotations errors loudly on malformed JSON, so a torn write
        // would read as "your notes file is corrupt".
        let dir = temp_case_dir("failed-save");
        let path = dir.join("notes.json");
        let good = AnnotationFile {
            format_version: 1,
            project: None,
            groups: Vec::new(),
            tables: BTreeMap::from([(
                "public.keep".to_string(),
                TableAnnotation { group: None, note: Some("survives".into()), columns: BTreeMap::new() },
            )]),
        };
        save_annotations(&path, &good).expect("first save");

        // A directory where the temp file wants to be makes File::create fail.
        std::fs::create_dir(path.with_extension("json.tmp")).expect("block the temp path");
        let result = save_annotations(&path, &good);

        assert!(result.is_err(), "save must fail when the temp path is unusable");
        let loaded = load_annotations(&path).expect("load").expect("present");
        assert_eq!(loaded.tables["public.keep"].note.as_deref(), Some("survives"));
    }

    #[test]
    fn an_explicit_notes_path_wins_over_the_default() {
        let resolved =
            resolve_notes_path("conn-1", Some("/tmp/team/schema-notes.json"), std::path::Path::new("/data"));
        assert_eq!(resolved, std::path::PathBuf::from("/tmp/team/schema-notes.json"));
    }

    #[test]
    fn the_default_notes_path_is_keyed_by_connection_id() {
        let resolved = resolve_notes_path("conn-1", None, std::path::Path::new("/data"));
        assert_eq!(resolved, std::path::PathBuf::from("/data/docs-notes/conn-1.json"));
    }

    #[test]
    fn a_blank_notes_path_falls_back_to_the_default() {
        // An empty string in the config is a cleared field, not a path to a
        // file named "". Treating it as explicit would resolve to garbage.
        let resolved = resolve_notes_path("conn-1", Some("   "), std::path::Path::new("/data"));
        assert_eq!(resolved, std::path::PathBuf::from("/data/docs-notes/conn-1.json"));
    }
```

Callers pass `&config.id, config.docs_notes_path.as_deref(), data_dir`.

`dbx-core` has NO `[dev-dependencies]` section and therefore no `tempfile`. The idiom already used
in this file (around line 319) is `std::env::temp_dir()` plus a uuid suffix — `uuid` is a regular
dependency of this crate. Add this helper inside `mod tests` beside the others:

```rust
    fn temp_case_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-notes-{label}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }
```

- [x] **Step 2: Run and watch them fail**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo test -p dbx-core --lib docs::annotations
```
Expected: FAIL — `save_annotations` and `resolve_notes_path` are not defined.

- [x] **Step 3: Implement**

Add to `annotations.rs`. It already has `use std::path::Path`; add `std::io::Write` and `std::path::PathBuf`.

```rust
/// Write the notes file atomically.
///
/// A partial write destroys prose a human typed, and `load_annotations`
/// errors loudly on malformed JSON — so a torn write becomes "your notes file
/// is corrupt" the next time the viewer opens. Write a sibling temp file,
/// flush it to disk, then rename: rename within a directory is atomic on
/// every platform DBX targets.
pub fn save_annotations(path: &Path, annotations: &AnnotationFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(annotations)
        .map_err(|error| format!("Failed to serialize notes: {error}"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let temp = path.with_extension("json.tmp");
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|error| format!("Failed to create {}: {error}", temp.display()))?;
        file.write_all(json.as_bytes())
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.sync_all().map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }

    std::fs::rename(&temp, path).map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

/// Where a connection's notes file lives.
///
/// An explicit `docs_notes_path` wins — that is the entire point of the field.
/// Pointing it at a file inside a repository is what lets schema documentation
/// be reviewed in pull requests. Otherwise the file lives under the app data
/// directory keyed by connection id, so the feature works with no setup.
///
/// Takes the two fields it needs rather than a whole `ConnectionConfig`:
/// that struct has no `Default` and ~60 fields, so passing it would force
/// every test to build a literal full of values the function never reads.
/// `data_dir` is a parameter because `dbx-core` cannot reach the caller's
/// data directory on its own.
pub fn resolve_notes_path(connection_id: &str, docs_notes_path: Option<&str>, data_dir: &Path) -> PathBuf {
    if let Some(path) = docs_notes_path.map(str::trim).filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    data_dir.join("docs-notes").join(format!("{connection_id}.json"))
}
```

Add `use crate::models::connection::ConnectionConfig;` if the file does not already import it.

- [x] **Step 4: Run and watch them pass**

```bash
cargo test -p dbx-core --lib docs::annotations
```

- [x] **Step 5: Verify two guards bite**

One at a time, restoring between each. Report both failure messages.

1. Replace the temp-file-and-rename body with a direct `std::fs::write(path, json)` → `a_failed_save_leaves_the_previous_file_intact` must fail.
2. Delete the `.filter(|value| !value.is_empty())` from `resolve_notes_path` → `a_blank_notes_path_falls_back_to_the_default` must fail.

- [x] **Step 6: Commit**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo clippy -p dbx-core --all-targets
git add crates/dbx-core/src/docs/annotations.rs
git commit -m "feat(docs): add atomic annotation save and notes path resolution"
```

---

## Task 2: Tauri commands

**Files:**
- Create: `src-tauri/src/commands/docs.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs:1411`

**Interfaces:**
- Consumes: `save_annotations`, `resolve_notes_path` (Task 1); existing `collect_snapshot`, `load_annotations`, `apply_annotations`
- Produces: commands `docs_collect_snapshot`, `docs_load_annotations`, `docs_apply_annotations`, `docs_save_annotations`

- [x] **Step 1: Create the command module**

`src-tauri/src/commands/docs.rs`:

```rust
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use dbx_core::connection::AppState;
// `apply_annotations` is NOT re-exported at `dbx_core::docs` — that module's
// `pub use` list covers collector, color, dbml, keys, relations and snapshot,
// but not annotations. It must come from the submodule path.
use dbx_core::docs::annotations::{
    apply_annotations, load_annotations, resolve_notes_path, save_annotations, AnnotationFile,
};
use dbx_core::docs::{collect_snapshot, CollectOptions, SchemaSnapshot};
use dbx_core::models::connection::ConnectionConfig;
use tauri::State;

async fn connection_of(state: &Arc<AppState>, connection_id: &str) -> Result<ConnectionConfig, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).cloned().ok_or_else(|| format!("Connection {connection_id} not found."))
}

/// The notes file for a connection, resolved against DBX's data directory.
///
/// `AppState.storage.data_dir()` is the directory DBX is actually using — it
/// honours a custom data dir, which a fresh `app_data_dir()` lookup would not.
/// (`dbx-mcp::paths::app_data_dir()` is NOT available here: src-tauri does not
/// depend on dbx-mcp.)
async fn notes_path_of(state: &Arc<AppState>, connection_id: &str) -> Result<std::path::PathBuf, String> {
    let config = connection_of(state, connection_id).await?;
    Ok(resolve_notes_path(&config.id, config.docs_notes_path.as_deref(), state.storage.data_dir()))
}

/// Collect a RAW snapshot — annotations are applied separately, so the
/// frontend can re-derive after an edit without touching the database.
#[tauri::command]
pub async fn docs_collect_snapshot(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schemas: Vec<String>,
    tables: Vec<String>,
    project_name: Option<String>,
) -> Result<SchemaSnapshot, String> {
    let config = connection_of(&state, &connection_id).await?;
    let options = CollectOptions {
        database,
        schemas,
        tables,
        project_name: project_name.unwrap_or_else(|| config.name.clone()),
    };
    collect_snapshot(&state, &config, &options, &|_progress| {}, &AtomicBool::new(false)).await
}

#[tauri::command]
pub async fn docs_load_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Option<AnnotationFile>, String> {
    let path = notes_path_of(&state, &connection_id).await?;
    load_annotations(&path)
}

/// Apply annotations to a raw snapshot. Pure — no database access.
///
/// This exists so the `shadowedNote` rule has exactly ONE implementation.
/// Re-implementing it in TypeScript to update the view optimistically is the
/// drift this feature has repeatedly suffered from.
#[tauri::command]
pub async fn docs_apply_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    snapshot: SchemaSnapshot,
    annotations: AnnotationFile,
) -> Result<SchemaSnapshot, String> {
    let config = connection_of(&state, &connection_id).await?;
    let mut applied = snapshot;
    apply_annotations(&mut applied, &annotations, config.db_type);
    Ok(applied)
}

#[tauri::command]
pub async fn docs_save_annotations(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    annotations: AnnotationFile,
) -> Result<(), String> {
    let path = notes_path_of(&state, &connection_id).await?;
    save_annotations(&path, &annotations)
}
```

The `use` lines above are correct as written — I verified them against `crates/dbx-core/src/docs/mod.rs`. `collect_snapshot`, `CollectOptions` and `SchemaSnapshot` ARE re-exported at the `docs` root; `apply_annotations` and friends are NOT, and come from `docs::annotations`.

- [x] **Step 2: Declare and register**

Add `pub mod docs;` to `src-tauri/src/commands/mod.rs` beside its siblings. Add these four to the `generate_handler![` list at `src-tauri/src/lib.rs:1411`, matching the surrounding entries' formatting:

```rust
            commands::docs::docs_collect_snapshot,
            commands::docs::docs_load_annotations,
            commands::docs::docs_apply_annotations,
            commands::docs::docs_save_annotations,
```

- [x] **Step 3: Build**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo check -p dbx
cargo clippy -p dbx --all-targets
```
Both must be clean. There are no unit tests for this task: the commands are thin adapters over Task 1's tested functions, and a test asserting a delegation reimplements the delegation.

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/commands/docs.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(docs): add Tauri commands for docs snapshot and annotations"
```

---

## Task 3: Web route parity

**Files:**
- Modify: `crates/dbx-web/src/routes/docs.rs`, `crates/dbx-web/src/main.rs:377`

**Interfaces:**
- Consumes: the same `dbx-core` functions as Task 2
- Produces: `POST /api/docs/annotations/load`, `/api/docs/annotations/apply`, `/api/docs/annotations/save`

- [x] **Step 1: Add three handlers**

Append to `crates/dbx-web/src/routes/docs.rs`, matching the existing `collect_snapshot` handler's style and its `#[serde(rename_all = "camelCase")]` request structs:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsAnnotationsRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsApplyRequest {
    pub connection_id: String,
    pub snapshot: SchemaSnapshot,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSaveRequest {
    pub connection_id: String,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

/// `WebState` already carries the data directory (`pub data_dir: PathBuf`), so
/// this needs no lookup and no new dependency — dbx-web does NOT depend on
/// dbx-mcp.
fn notes_path_for(state: &Arc<WebState>, config: &ConnectionConfig) -> std::path::PathBuf {
    dbx_core::docs::annotations::resolve_notes_path(&config.id, config.docs_notes_path.as_deref(), &state.data_dir)
}

pub async fn load_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsAnnotationsRequest>,
) -> Result<Json<Option<dbx_core::docs::annotations::AnnotationFile>>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config);
    Ok(Json(dbx_core::docs::annotations::load_annotations(&path).map_err(AppError::from)?))
}

pub async fn apply_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsApplyRequest>,
) -> Result<Json<SchemaSnapshot>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let mut applied = request.snapshot;
    dbx_core::docs::annotations::apply_annotations(&mut applied, &request.annotations, config.db_type);
    Ok(Json(applied))
}

pub async fn save_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsSaveRequest>,
) -> Result<Json<()>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config);
    dbx_core::docs::annotations::save_annotations(&path, &request.annotations).map_err(AppError::from)?;
    Ok(Json(()))
}
```

Do NOT add a `dbx-mcp` dependency to `dbx-web` — it has none, and it does not need one. `WebState` already carries `pub data_dir: PathBuf`, which is what the handlers use.

- [x] **Step 2: Register the routes**

At `crates/dbx-web/src/main.rs:377`, beside the existing `/docs/snapshot` line:

```rust
        .route("/docs/annotations/load", post(routes::docs::load_annotations))
        .route("/docs/annotations/apply", post(routes::docs::apply_annotations))
        .route("/docs/annotations/save", post(routes::docs::save_annotations))
```

- [x] **Step 3: Build**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo check -p dbx-web && cargo clippy -p dbx-web --all-targets
```

- [x] **Step 4: Commit**

```bash
git add crates/dbx-web/src/routes/docs.rs crates/dbx-web/src/main.rs
git commit -m "feat(docs): add web routes for annotation load, apply and save"
```

---

## Task 4: Frontend backend facade and annotation types

**Files:**
- Modify: `apps/desktop/src/docs/types.ts`, `apps/desktop/src/lib/backend/tauri.ts`, `apps/desktop/src/lib/backend/http.ts`, `apps/desktop/src/lib/backend/api.ts`
- Test: `apps/desktop/src/docs/__tests__/annotationTypes.spec.ts` (create)

**Interfaces:**
- Produces: TS types `AnnotationFile`, `ProjectAnnotation`, `GroupAnnotation`, `TableAnnotation`, `ColumnAnnotation`; and `collectDocsSnapshot`, `loadDocsAnnotations`, `applyDocsAnnotations`, `saveDocsAnnotations` exported from `@/lib/backend/api`

- [x] **Step 1: Add the types**

Append to `apps/desktop/src/docs/types.ts`. These mirror Rust structs carrying `deny_unknown_fields`, so an extra property is a hard deserialization error on the Rust side — the shapes must match exactly.

```ts
/** Mirrors `dbx_core::docs::annotations::ColumnAnnotation`. */
export interface ColumnAnnotation {
  note: string;
}

/** Mirrors `TableAnnotation`. Absent keys are omitted, never sent as null. */
export interface TableAnnotation {
  group?: string;
  note?: string;
  columns?: Record<string, ColumnAnnotation>;
}

/** Mirrors `GroupAnnotation`. `hue` is 0–359; lightness and chroma are the theme's. */
export interface GroupAnnotation {
  id: string;
  name: string;
  hue: number;
  note?: string;
}

/** Mirrors `ProjectAnnotation`. */
export interface ProjectAnnotation {
  name?: string;
  note?: string;
}

/**
 * The on-disk notes file. Rust declares `deny_unknown_fields`, so adding a
 * property here without adding it in Rust makes every save fail.
 */
export interface AnnotationFile {
  formatVersion: number;
  project?: ProjectAnnotation;
  groups?: GroupAnnotation[];
  tables?: Record<string, TableAnnotation>;
}
```

- [x] **Step 2: Write the failing conformance test**

`apps/desktop/src/docs/__tests__/annotationTypes.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Rust structs carry deny_unknown_fields, so any property TypeScript adds
// that Rust does not declare turns every save into a deserialization error at
// runtime. vue-tsc cannot see across the language boundary, so this reads the
// Rust source and compares the field sets directly.
const rustSource = readFileSync(
  path.resolve(__dirname, "../../../../../crates/dbx-core/src/docs/annotations.rs"),
  "utf8",
);

function rustFields(structName: string): string[] {
  const start = rustSource.indexOf(`pub struct ${structName} {`);
  expect(start, `struct ${structName} not found in annotations.rs`).toBeGreaterThan(-1);
  const body = rustSource.slice(start, rustSource.indexOf("\n}", start));
  return [...body.matchAll(/^\s{4}pub ([a-z_]+):/gm)].map((match) => toCamel(match[1])).sort();
}

function toCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

describe("annotation types match the Rust structs", () => {
  it.each([
    ["AnnotationFile", ["formatVersion", "groups", "project", "tables"]],
    ["ProjectAnnotation", ["name", "note"]],
    ["GroupAnnotation", ["hue", "id", "name", "note"]],
    ["TableAnnotation", ["columns", "group", "note"]],
    ["ColumnAnnotation", ["note"]],
  ])("%s", (structName, expected) => {
    expect(rustFields(structName as string)).toEqual(expected);
  });
});
```

- [x] **Step 3: Run and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/annotationTypes.spec.ts
```
Expected: PASS, 5 cases. If a field set mismatches, the TypeScript above is wrong — fix the TypeScript, not the test, and report what differed.

- [x] **Step 4: Verify it bites**

Add `extra?: string;` to the TS `GroupAnnotation` and confirm the `GroupAnnotation` case FAILS. Restore. Report the message.

- [x] **Step 5: Add the four backend functions**

In `apps/desktop/src/lib/backend/tauri.ts`, following the file's existing `invoke` idiom:

```ts
export async function collectDocsSnapshot(
  connectionId: string,
  database: string,
  schemas: string[],
  tables: string[],
  projectName?: string,
): Promise<SchemaSnapshot> {
  return invoke("docs_collect_snapshot", { connectionId, database, schemas, tables, projectName });
}

export async function loadDocsAnnotations(connectionId: string): Promise<AnnotationFile | null> {
  return invoke("docs_load_annotations", { connectionId });
}

export async function applyDocsAnnotations(
  connectionId: string,
  snapshot: SchemaSnapshot,
  annotations: AnnotationFile,
): Promise<SchemaSnapshot> {
  return invoke("docs_apply_annotations", { connectionId, snapshot, annotations });
}

export async function saveDocsAnnotations(connectionId: string, annotations: AnnotationFile): Promise<void> {
  return invoke("docs_save_annotations", { connectionId, annotations });
}
```

In `http.ts`, the same four signatures using that file's `post<T>(url, body)` helper (defined at
`http.ts:222`, which throws `backendResponseError` on a non-OK status and returns `res.json()`):

```ts
export async function collectDocsSnapshot(
  connectionId: string,
  database: string,
  schemas: string[],
  tables: string[],
  projectName?: string,
): Promise<SchemaSnapshot> {
  return post("/api/docs/snapshot", { connectionId, database, schemas, tables, projectName });
}

export async function loadDocsAnnotations(connectionId: string): Promise<AnnotationFile | null> {
  return post("/api/docs/annotations/load", { connectionId });
}

export async function applyDocsAnnotations(
  connectionId: string,
  snapshot: SchemaSnapshot,
  annotations: AnnotationFile,
): Promise<SchemaSnapshot> {
  return post("/api/docs/annotations/apply", { connectionId, snapshot, annotations });
}

export async function saveDocsAnnotations(connectionId: string, annotations: AnnotationFile): Promise<void> {
  return post("/api/docs/annotations/save", { connectionId, annotations });
}
```

**The two transports must expose identical signatures.** `api.ts` types the backend as `typeof TauriModule` and `forward()` re-exports by name, so a signature that differs between `tauri.ts` and `http.ts` is a type error at the facade — which is the only place it would ever be caught.

**Tauri serialises command arguments BY NAME.** The Rust commands take `connection_id`, `database`, `schemas`, `tables`, `project_name`, `snapshot`, `annotations`; Tauri converts camelCase to snake_case automatically, so the `invoke` object keys above must be exactly `connectionId`, `database`, `schemas`, `tables`, `projectName`, `snapshot`, `annotations`. A mismatch compiles cleanly on both sides and fails only at runtime when a user clicks.

In `api.ts`, beside the other forwards:

```ts
export const collectDocsSnapshot = forward("collectDocsSnapshot");
export const loadDocsAnnotations = forward("loadDocsAnnotations");
export const applyDocsAnnotations = forward("applyDocsAnnotations");
export const saveDocsAnnotations = forward("saveDocsAnnotations");
```

- [x] **Step 6: Verify and commit**

```bash
pnpm vitest run apps/desktop/src/docs
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs apps/desktop/src/lib/backend
git commit -m "feat(docs): expose docs snapshot and annotations to the frontend"
```

`vue-tsc` must be clean — `tauri.ts` and `http.ts` are type-checked, and a signature mismatch between them is exactly what `forward()` cannot catch.

---

## Task 5: Pure annotation edits

**Files:**
- Create: `apps/desktop/src/docs/annotationEdits.ts`
- Test: `apps/desktop/src/docs/__tests__/annotationEdits.spec.ts`

**Interfaces:**
- Consumes: `AnnotationFile`, `TableAnnotation`, `GroupAnnotation` (Task 4)
- Produces: `emptyAnnotations()`, `setProjectNote`, `setTableNote`, `setColumnNote`, `setTableGroup`, `upsertGroup`, `removeGroup` — every one `(file, ...args) => AnnotationFile`

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  emptyAnnotations,
  removeGroup,
  setColumnNote,
  setProjectNote,
  setTableGroup,
  setTableNote,
  upsertGroup,
} from "../annotationEdits";

const base = emptyAnnotations();

describe("annotationEdits", () => {
  it("starts from a valid empty file", () => {
    expect(emptyAnnotations()).toEqual({ formatVersion: 1 });
  });

  it("never mutates its input", () => {
    // Every function returns a new file. Mutating in place would make Vue's
    // reactivity miss the change and make undo impossible to add later.
    const before = JSON.stringify(base);
    setTableNote(base, "public.orders", "hello");
    expect(JSON.stringify(base)).toBe(before);
  });

  it("sets and clears a table note", () => {
    const withNote = setTableNote(base, "public.orders", "One row per checkout.");
    expect(withNote.tables?.["public.orders"].note).toBe("One row per checkout.");

    const cleared = setTableNote(withNote, "public.orders", "   ");
    expect(cleared.tables?.["public.orders"]).toBeUndefined();
  });

  it("keeps a table entry when it still carries a group after the note clears", () => {
    // Dropping the whole entry here would silently unassign the group.
    const grouped = setTableGroup(setTableNote(base, "public.orders", "n"), "public.orders", "g1");
    const cleared = setTableNote(grouped, "public.orders", "");
    expect(cleared.tables?.["public.orders"].group).toBe("g1");
    expect(cleared.tables?.["public.orders"].note).toBeUndefined();
  });

  it("sets and clears a column note", () => {
    const withNote = setColumnNote(base, "public.orders", "status", "Lifecycle state.");
    expect(withNote.tables?.["public.orders"].columns?.status.note).toBe("Lifecycle state.");

    const cleared = setColumnNote(withNote, "public.orders", "status", "");
    expect(cleared.tables?.["public.orders"]).toBeUndefined();
  });

  it("upserts a group by id", () => {
    const created = upsertGroup(base, { id: "g1", name: "Core", hue: 28 });
    expect(created.groups).toEqual([{ id: "g1", name: "Core", hue: 28 }]);

    const renamed = upsertGroup(created, { id: "g1", name: "Core Accounts", hue: 200 });
    expect(renamed.groups).toHaveLength(1);
    expect(renamed.groups?.[0]).toEqual({ id: "g1", name: "Core Accounts", hue: 200 });
  });

  it("removing a group also clears every table that referenced it", () => {
    // A dangling groupId renders as no group at all, so the file would look
    // correct while carrying a reference to something that does not exist.
    const withGroup = setTableGroup(upsertGroup(base, { id: "g1", name: "Core", hue: 28 }), "public.orders", "g1");
    const removed = removeGroup(withGroup, "g1");

    expect(removed.groups ?? []).toEqual([]);
    expect(removed.tables?.["public.orders"]).toBeUndefined();
  });

  it("removing a group keeps a table that still has a note", () => {
    const seeded = setTableNote(
      setTableGroup(upsertGroup(base, { id: "g1", name: "Core", hue: 28 }), "public.orders", "g1"),
      "public.orders",
      "keep me",
    );
    const removed = removeGroup(seeded, "g1");
    expect(removed.tables?.["public.orders"].note).toBe("keep me");
    expect(removed.tables?.["public.orders"].group).toBeUndefined();
  });

  it("sets and clears the project note", () => {
    const withNote = setProjectNote(base, "# Sales\n\nThe billing schema.");
    expect(withNote.project?.note).toBe("# Sales\n\nThe billing schema.");
    expect(setProjectNote(withNote, "").project).toBeUndefined();
  });
});
```

- [x] **Step 2: Run and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/annotationEdits.spec.ts
```
Expected: FAIL — cannot resolve `../annotationEdits`.

- [x] **Step 3: Implement**

```ts
import type { AnnotationFile, GroupAnnotation, TableAnnotation } from "./types";

/**
 * Every function here returns a NEW file rather than mutating.
 *
 * Empty or whitespace-only prose removes the entry instead of storing "" —
 * the notes file is meant to be committed and reviewed, so it must not
 * accumulate keys holding nothing.
 */
export function emptyAnnotations(): AnnotationFile {
  return { formatVersion: 1 };
}

function blank(value: string): boolean {
  return value.trim() === "";
}

/** Drop a table entry once it carries neither a note nor a group. */
function pruneTable(tables: Record<string, TableAnnotation>, key: string): Record<string, TableAnnotation> {
  const entry = tables[key];
  const empty =
    entry !== undefined &&
    entry.note === undefined &&
    entry.group === undefined &&
    Object.keys(entry.columns ?? {}).length === 0;
  if (!empty) {
    return tables;
  }
  const { [key]: _dropped, ...rest } = tables;
  return rest;
}

function withTable(file: AnnotationFile, key: string, change: (entry: TableAnnotation) => TableAnnotation): AnnotationFile {
  const tables = { ...(file.tables ?? {}) };
  tables[key] = change(tables[key] ?? {});
  const pruned = pruneTable(tables, key);
  return { ...file, tables: Object.keys(pruned).length > 0 ? pruned : undefined };
}

export function setTableNote(file: AnnotationFile, tableKey: string, note: string): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const { note: _old, ...rest } = entry;
    return blank(note) ? rest : { ...rest, note };
  });
}

export function setColumnNote(file: AnnotationFile, tableKey: string, column: string, note: string): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const columns = { ...(entry.columns ?? {}) };
    if (blank(note)) {
      delete columns[column];
    } else {
      columns[column] = { note };
    }
    const { columns: _old, ...rest } = entry;
    return Object.keys(columns).length > 0 ? { ...rest, columns } : rest;
  });
}

export function setTableGroup(file: AnnotationFile, tableKey: string, groupId: string | null): AnnotationFile {
  return withTable(file, tableKey, (entry) => {
    const { group: _old, ...rest } = entry;
    return groupId === null ? rest : { ...rest, group: groupId };
  });
}

export function upsertGroup(file: AnnotationFile, group: GroupAnnotation): AnnotationFile {
  const groups = [...(file.groups ?? [])];
  const index = groups.findIndex((candidate) => candidate.id === group.id);
  if (index >= 0) {
    groups[index] = group;
  } else {
    groups.push(group);
  }
  return { ...file, groups };
}

/**
 * Remove a group and every reference to it.
 *
 * `docsIndex` already drops a dangling groupId when rendering, so the viewer
 * degrades correctly either way — but the committed file should not carry a
 * reference to a group that no longer exists.
 */
export function removeGroup(file: AnnotationFile, groupId: string): AnnotationFile {
  const groups = (file.groups ?? []).filter((group) => group.id !== groupId);
  let next: AnnotationFile = { ...file, groups };
  for (const [key, entry] of Object.entries(file.tables ?? {})) {
    if (entry.group === groupId) {
      next = setTableGroup(next, key, null);
    }
  }
  return next;
}

export function setProjectNote(file: AnnotationFile, note: string): AnnotationFile {
  const project = { ...(file.project ?? {}) };
  if (blank(note)) {
    delete project.note;
  } else {
    project.note = note;
  }
  return { ...file, project: Object.keys(project).length > 0 ? project : undefined };
}
```

- [x] **Step 4: Run and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/annotationEdits.spec.ts
```

- [x] **Step 5: Verify two guards bite**

One at a time, restoring between each. Report both failure messages.

1. In `removeGroup`, delete the loop that clears table references → `removing a group also clears every table that referenced it` must fail.
2. In `pruneTable`, drop the `entry.group === undefined` condition → `keeps a table entry when it still carries a group after the note clears` must fail.

- [x] **Step 6: Commit**

```bash
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs
git commit -m "feat(docs): add pure annotation edit transforms"
```

---

## Task 6: i18n namespace and the parity guard

**Files:**
- Create: `apps/desktop/src/i18n/locales/docs/{en,es,it,ja,ko,pt-BR,zh-CN,zh-TW}.ts` — the namespace, one module per locale
- Modify: all 8 files in `apps/desktop/src/i18n/locales/` — import and spread their docs module
- Modify: `apps/desktop/src/docs/docsWarnings.ts` and its spec
- Create: `apps/desktop/src/i18n/__tests__/docsNamespaceParity.spec.ts`

**Why the namespace gets its own modules.** Every non-English locale is
`export default withEnglishFallback({ … })` — the fallback is applied AT MODULE LEVEL, inside the
locale file. Only `en.ts` is a bare object. So `import ja from "../locales/ja"` yields the
ALREADY-MERGED object, and a parity test comparing default exports would find every key present in
every locale and pass while translations were missing. The test written to catch silent English
fallback would be silently defeated by it.

Putting the new namespace in its own per-locale modules makes each locale's OWN keys importable
without the merge, which is the only way this property is observable at all. It is a small
structural change scoped entirely to the new namespace; the existing 315 KB of keys are untouched.

**Interfaces:**
- Produces: `describeWarning(warning: SnapshotWarning, translate: Translate): WarningNotice` — the existing return type, unchanged — where `type Translate = (key: string, params?: Record<string, string | number>) => string`

- [x] **Step 1: Write the failing parity test**

```ts
import { describe, expect, it } from "vitest";
import en from "../locales/docs/en";
import es from "../locales/docs/es";
import it_ from "../locales/docs/it";
import ja from "../locales/docs/ja";
import ko from "../locales/docs/ko";
import ptBR from "../locales/docs/pt-BR";
import zhCN from "../locales/docs/zh-CN";
import zhTW from "../locales/docs/zh-TW";

// These import the per-locale DOCS modules, NOT ../locales/<name>.
//
// Every non-English locale file is `export default withEnglishFallback({...})`,
// which deep-merges `en` UNDER the locale at module level. Importing those
// default exports yields the ALREADY-MERGED object, so every locale appears to
// have every key and this test would pass while translations were missing —
// the fallback would silently defeat the test written to catch it.
const locales: Array<[string, Record<string, unknown>]> = [
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("docs i18n namespace parity", () => {
  const expected = leafKeys(en as Record<string, unknown>).sort();

  it("english declares the docs namespace", () => {
    expect(expected.length, "locales/docs/en.ts must declare keys").toBeGreaterThan(0);
  });

  it.each(locales)("%s declares exactly the same docs keys as en", (_name, locale) => {
    expect(leafKeys(locale).sort()).toEqual(expected);
  });
});
```

- [x] **Step 2: Run and watch it fail**

```bash
pnpm vitest run apps/desktop/src/i18n/__tests__/docsNamespaceParity.spec.ts
```
Expected: FAIL — no locale declares `docs`, so `leafKeys(undefined)` yields `[""]` and the English assertion fails first.

- [x] **Step 3: Create `apps/desktop/src/i18n/locales/docs/en.ts`**

```ts
export default {
    title: "Documentation",
    groupBySchema: "Schemas",
    groupByTableGroup: "Table Groups",
    noGroup: "(no group)",
    noSchema: "(no schema)",
    search: "Search tables, columns, groups…",
    columns: "Columns",
    indexes: "Indexes",
    references: "References",
    referencedBy: "Referenced by",
    localNote: "LOCAL",
    shadowedComment: "Database comment: {comment}",
    addNote: "Add a note",
    editNote: "Edit note",
    newGroup: "New group…",
    groupName: "Group name",
    groupColour: "Colour",
    deleteGroup: "Delete group",
    enumValues: "Values",
    usedBy: "Used by",
    openDiagram: "Open schema diagram",
    saving: "Saving…",
    saved: "Saved",
    saveFailed: "Could not save notes: {error}",
    warnings: {
      tableSkipped: "{table} could not be read: {reason}",
      noForeignKeyMetadata: "{engine} does not report foreign key metadata, so this schema has no relationships to show.",
      commentsUnsupported: "{engine} does not support table or column comments, so notes here come only from DBX.",
      orphanedNotes: "{count} note(s) refer to tables or columns that no longer exist. Nothing was deleted.",
      dbmlOmitted: "{item} on {table} was left out of the DBML: {reason}",
    },
};
```

Then in `apps/desktop/src/i18n/locales/en.ts`, import it and spread it in alphabetical position:

```ts
import docs from "./docs/en";
// …
  docs,
```

- [x] **Step 4: Translate into the other 7 locales**

Create `locales/docs/{es,it,ja,ko,pt-BR,zh-CN,zh-TW}.ts` with the same key structure and translated
values, and wire each into its locale file the same way (`import docs from "./docs/ja";` … `docs,`). Keep every interpolation placeholder (`{table}`, `{engine}`, `{count}`, `{reason}`, `{item}`, `{comment}`, `{error}`) exactly as written — a translated placeholder name renders literally.

Keep technical terms in English where a developer would say them in English: for `pt-BR` that means "schema", "commit", "cache", "index" stay English while "banco de dados", "arquivo", "fila" are Portuguese.

- [x] **Step 5: Run the parity test**

```bash
pnpm vitest run apps/desktop/src/i18n/__tests__/docsNamespaceParity.spec.ts
```
Expected: PASS, 8 cases.

- [x] **Step 6: Verify it bites**

Delete one key from `locales/docs/ja.ts` and confirm the `ja` case FAILS naming that key. Restore. Report the message.

Then verify the test could not have been vacuous: temporarily point the imports at `../locales/<name>` instead of `../locales/docs/<name>`, delete a key from `locales/docs/ja.ts` again, and confirm the test now PASSES despite the missing key — that is the trap this structure exists to avoid. Restore both. Report what you saw.

- [x] **Step 7: Change `describeWarning` to take a translator**

`docsWarnings.ts` currently returns hardcoded English. Change its signature so `src/docs/` never imports vue-i18n — `useI18n()` throws without a provided instance, which is exactly the Part 3c export case:

```ts
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function describeWarning(warning: SnapshotWarning, translate: Translate): WarningNotice {
  switch (warning.kind) {
    case "tableSkipped":
      return { severity: "warning", text: translate("docs.warnings.tableSkipped", { table: warning.table, reason: warning.reason }) };
    // …one arm per variant, each calling translate with the same params the
    // existing English strings interpolate. Keep the exhaustive switch with
    // NO default arm — the missing-arm compile error is the guard.
  }
}
```

Update `docsWarnings.spec.ts` to pass a fake translator that returns `` `${key}:${JSON.stringify(params)}` ``, and assert on that rather than on English prose. The tests then check the key and params, which is what actually matters now.

- [x] **Step 8: Verify and commit**

```bash
pnpm vitest run apps/desktop/src/docs apps/desktop/src/i18n
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
git add apps/desktop/src/docs apps/desktop/src/i18n
git commit -m "feat(docs): add the docs i18n namespace with a parity guard"
```

---

## Task 7: Editing components

**Files:**
- Create: `apps/desktop/src/docs/components/NoteEditor.vue`, `GroupEditor.vue`, `GroupPicker.vue`
- Modify: `apps/desktop/src/docs/__tests__/componentContract.spec.ts`

**Interfaces:**
- Consumes: `renderNote` (Part 3a), `groupStyle` (Part 3a), `GroupAnnotation` (Task 4)
- Produces: `NoteEditor` (`modelValue: string`, `readonly: boolean`, emits `update:modelValue`), `GroupEditor` (`group: GroupAnnotation`, emits `update:group`, `delete`), `GroupPicker` (`groups: GroupAnnotation[]`, `modelValue: string | null`, emits `update:modelValue`, `create`)

- [x] **Step 1: Extend the contract test**

In `componentContract.spec.ts`, update `EXPECTED` to include the three new files, and add:

```ts
  it("editing components accept a readonly mode", () => {
    // Part 3c renders these same components with editing off inside an
    // exported HTML file. A component that cannot be made read-only would
    // have to be forked for the export.
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    const editors = files.filter((file) => path.basename(file) === "NoteEditor.vue");
    expect(editors.length).toBe(1);
    expect(readFileSync(editors[0], "utf8")).toContain("readonly");
  });
```

- [x] **Step 2: Run and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/componentContract.spec.ts
```
Expected: FAIL on the file list — the three components do not exist.

- [x] **Step 3: Build the three components**

`NoteEditor.vue` — renders `renderNote` output until clicked, then a raw markdown textarea. The `v-html` must bind `renderNote(...)`; the contract test enforces it in either quote style. When `readonly` is true it never becomes editable.

`GroupEditor.vue` — a name input plus the hue picker from the approved mock: 12 preset swatches, a
`<input type="range" min="0" max="359">`, and a preview element rendering the colour on light and
dark grounds at once.

**Match the swatch idiom DBX already uses**, in `ConnectionDialog.vue:4921-4931` — a row of
`h-6 w-6 rounded-full border` buttons inside `flex items-center gap-1.5`, selected state
`ring-2 ring-ring ring-offset-2`, unselected `border-border`, each with a `:title` from an i18n key.
Read it before writing yours so the new picker looks native rather than invented.

**But do NOT copy how it fills them.** Connection colours are hex values painted with Tailwind
classes (`bg-green-500`, `#22c55e`). Group colours are hues: the swatch must carry
`class="docs-group"` and `:style="groupStyle(hue)"` on the SAME element, and the colour is decided
by `docs.css`. The contract test forbids `oklch(` and six-digit hex literals in these components,
so a naive copy of `ConnectionDialog`'s approach fails the test — correctly, because a hardcoded
hex cannot stay legible on both light and dark grounds, which is the entire reason groups store a
hue rather than a colour.

`GroupPicker.vue` — a `<select>` over `groups` plus a "New group…" option emitting `create`.

All three: `<script setup lang="ts">`, Tailwind with DBX token names (`bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`), no store or backend imports, all strings via a `translate` prop or `t` passed from the parent — never `useI18n()` inside `src/docs/`.

- [x] **Step 4: Run the contract test**

```bash
pnpm vitest run apps/desktop/src/docs
```

- [x] **Step 5: Verify the v-html guard still bites on the new file**

Change `NoteEditor.vue`'s `v-html="renderNote(modelValue)"` to `v-html='modelValue'` (single quotes, raw value) and confirm the contract test FAILS. Restore. Report the message. This is the single most dangerous thing a template here can do — a database `COMMENT ON` value going straight to the DOM.

- [x] **Step 6: Commit**

```bash
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs
git commit -m "feat(docs): add note editor, group editor and group picker"
```

---

## Task 8: Enum page

**Files:**
- Create: `apps/desktop/src/docs/components/EnumPage.vue`
- Create: `apps/desktop/src/docs/docsKeys.ts`
- Modify: `apps/desktop/src/docs/docsIndex.ts`, `docsSearch.ts`, `DocsApp.vue`, `components/DocsSidebar.vue`, `components/WikiIndex.vue` (and any other component holding a `tableKey` copy), `apps/desktop/src/docs/__tests__/docsIndex.spec.ts`, `componentContract.spec.ts` (`EXPECTED`)

**Interfaces:**
- Produces: `columnsUsingEnum(snapshot: SchemaSnapshot, enumName: string): Array<{ tableKey: string; table: string; column: string }>`

- [x] **Step 1: Write the failing test**

Add to `docsIndex.spec.ts`:

```ts
  // The file's existing helper is `table(schema, name, groupId)` and builds a
  // table with NO columns, so these tests need columns attached. Add this
  // helper beside it rather than changing the existing signature — the other
  // tests in this file call it positionally.
  function withColumns(base: DocTable, columns: Array<{ name: string; type: string }>): DocTable {
    return {
      ...base,
      columns: columns.map((column) => ({
        name: column.name,
        data_type: column.type,
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: "",
        comment: null,
        numeric_precision: null,
        numeric_scale: null,
        character_maximum_length: null,
      })),
    };
  }

  function snapshotOf(tables: DocTable[], enums: SchemaSnapshot["enums"]): SchemaSnapshot {
    return {
      formatVersion: 1,
      project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
      tables,
      relationships: [],
      groups: [],
      enums,
      warnings: [],
    };
  }

  it("finds every column using an enum, across tables", () => {
    const snapshot = snapshotOf(
      [
        withColumns(table("public", "orders"), [{ name: "status", type: "order_status" }]),
        withColumns(table("public", "returns"), [{ name: "state", type: "order_status" }]),
        withColumns(table("public", "users"), [{ name: "id", type: "integer" }]),
      ],
      [{ schema: "public", name: "order_status", values: ["new"], note: null, synthesized: false }],
    );

    expect(columnsUsingEnum(snapshot, "order_status")).toEqual([
      { tableKey: "public.orders", table: "orders", column: "status" },
      { tableKey: "public.returns", table: "returns", column: "state" },
    ]);
  });

  it("returns nothing for an enum no column references", () => {
    // Must not fall back to "every column" or to a substring match — an enum
    // named `state` would otherwise claim every column whose type contains it.
    const snapshot = snapshotOf(
      [withColumns(table("public", "users"), [{ name: "id", type: "integer" }])],
      [{ schema: "public", name: "state", values: ["a"], note: null, synthesized: false }],
    );
    expect(columnsUsingEnum(snapshot, "state")).toEqual([]);
  });
```

Import `DocTable` and `SchemaSnapshot` as types if the spec file does not already. The `ColumnInfo` field list above is the full required set the conformance test pins — omitting one is a type error.

- [ ] **Step 2: Run and watch it fail**  <!-- not performed: columnsUsingEnum was already implemented and committed before this step was reached, so the failure was never observed. The exact-match guard was instead verified by Step 5. -->

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsIndex.spec.ts
```
Expected: FAIL — `columnsUsingEnum` is not exported.

- [x] **Step 3: Implement**

```ts
/**
 * Every column whose declared type is this enum.
 *
 * Exact match on `data_type`, never a substring: an enum named `state` would
 * otherwise claim every column of type `estado` or `statement`.
 */
export function columnsUsingEnum(
  snapshot: SchemaSnapshot,
  enumName: string,
): Array<{ tableKey: string; table: string; column: string }> {
  const hits: Array<{ tableKey: string; table: string; column: string }> = [];
  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      if (column.data_type === enumName) {
        hits.push({ tableKey: qualifiedTableKey(table), table: table.name, column: column.name });
      }
    }
  }
  return hits;
}
```

**The qualified table key is currently duplicated at least four times**, and this task would add a
fifth. Extract it first, into a new `apps/desktop/src/docs/docsKeys.ts`:

```ts
import type { DocTable } from "./types";

/**
 * The key that identifies a table across the viewer — `schema.name`, or the
 * bare name on schema-less engines like SQLite and MySQL.
 *
 * This rule was copied into four places before it lived here. It is the key
 * that annotations are stored under, so two call sites disagreeing would
 * attach a note to the wrong table.
 */
export function qualifiedTableKey(table: DocTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
```

Then replace every existing copy with an import of it:
- `docsSearch.ts:12` — the private `qualified(schema, name)`. It is called with loose arguments in
  places, so either adapt those call sites or keep a thin local wrapper that delegates; say which
  you did.
- `DocsApp.vue:22`, `components/DocsSidebar.vue:19`, `components/WikiIndex.vue:15` — each has its
  own `tableKey(table)`. Check the remaining components for further copies and replace those too;
  report how many you found in total.

Note `docsIndex.ts` does NOT contain a copy — it groups by `table.schema ?? ""`, which is a
*section* key, not a table key. Do not change that.

This extraction is in scope deliberately: Part 3a's final review flagged the duplication as a
Minor and it was deferred, and this task is the moment a new consumer appears.

- [x] **Step 4: Run and watch it pass, then build `EnumPage.vue`**

A thin template: the enum's qualified name, its values, its note via `NoteEditor`, and the `columnsUsingEnum` list with each entry clickable to that table. Add it to `EXPECTED` in the contract test.

- [x] **Step 5: Verify it bites**

Change `column.data_type === enumName` to `column.data_type.includes(enumName)` and confirm `returns nothing for an enum no column references` FAILS. Restore. Report the message.

- [x] **Step 6: Commit**

```bash
pnpm vitest run apps/desktop/src/docs
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
git add apps/desktop/src/docs
git commit -m "feat(docs): add the enum page and its reverse column lookup"
```

---

## Task 9: Wire editing through `DocsApp`

**Files:**
- Modify: `apps/desktop/src/docs/DocsApp.vue` and the components it renders
- Modify: `apps/desktop/src/docs/__tests__/componentContract.spec.ts`

**Interfaces:**
- Produces: `DocsApp` props `snapshot: SchemaSnapshot`, `annotations: AnnotationFile`, `readonly?: boolean`, `translate: Translate`; emits `edit` with a discriminated payload

**`snapshot` and `translate` already exist** on `DocsApp` (`translate` was added when the i18n task
made `describeWarning` take a translator). You are ADDING `annotations` and `readonly` to the
existing `defineProps`, not writing it from scratch. `readonly` is the only optional one.

- [x] **Step 1: Define the edit payload**

In `apps/desktop/src/docs/types.ts`:

```ts
/**
 * What the viewer asks its host to do. The viewer never persists anything —
 * that is what keeps `src/docs/` free of backend calls and bundleable into a
 * standalone HTML file.
 */
export type DocsEdit =
  | { kind: "projectNote"; note: string }
  | { kind: "tableNote"; tableKey: string; note: string }
  | { kind: "columnNote"; tableKey: string; column: string; note: string }
  | { kind: "tableGroup"; tableKey: string; groupId: string | null }
  | { kind: "upsertGroup"; group: GroupAnnotation }
  | { kind: "removeGroup"; groupId: string };
```

- [x] **Step 2: Add the contract test**

```ts
  it("the viewer emits edits rather than persisting them", () => {
    // src/docs/ must stay free of I/O so Part 3c can bundle it. Editing works
    // by emitting upward; the dialog outside this directory does the saving.
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const needle of ["saveDocsAnnotations", "loadDocsAnnotations", "applyDocsAnnotations"]) {
        expect(source.includes(needle), `${path.basename(file)} must not call ${needle}`).toBe(false);
      }
    }
  });
```

- [x] **Step 3: Thread `readonly` and `annotations` down; emit `edit` up**

`translate` is already threaded to `WarningBanner`; extend the same pattern to the other components as they gain strings.

`DocsApp` gains the props and re-emits `edit` from its children. Each component renders a `NoteEditor` where a note belongs and emits the matching `DocsEdit`. When `readonly` is true, no editor is interactive and `GroupEditor` / `GroupPicker` are not rendered.

- [x] **Step 4: Verify and commit**

```bash
pnpm vitest run apps/desktop/src/docs
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs
git commit -m "feat(docs): thread editing through the viewer as emitted events"
```

`vue-tsc` is the only thing type-checking these templates — treat any error as the real test and report it rather than suppressing it.

---

## Task 10: The dialog, autosave, and wiring

**Files:**
- Create: `apps/desktop/src/components/docs/DatabaseDocsDialog.vue`
- Create: `apps/desktop/src/components/docs/__tests__/docsAutosave.spec.ts`
- Create: `apps/desktop/src/components/docs/docsAutosave.ts`
- Modify: `apps/desktop/src/stores/connectionStore.ts`, `apps/desktop/src/composables/useDialogSources.ts`, `apps/desktop/src/components/layout/AppDialogs.vue`

**Interfaces:**
- Consumes: everything above
- Produces: `createAutosave(save, delayMs)` returning `{ schedule(file), status, flush() }`

- [x] **Step 1: Write the failing autosave tests**

Autosave logic goes in a `.ts` file so it is testable without mounting anything:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAutosave } from "../docsAutosave";

const file = { formatVersion: 1 } as const;

describe("createAutosave", () => {
  it("coalesces rapid edits into one save", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const autosave = createAutosave(save, 500);

    autosave.schedule(file);
    autosave.schedule(file);
    autosave.schedule(file);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("surfaces a failure instead of swallowing it", async () => {
    // A silently swallowed write failure is the worst outcome this feature
    // can produce: the user keeps typing and believes their notes are saved.
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const autosave = createAutosave(save, 500);

    autosave.schedule(file);
    await vi.advanceTimersByTimeAsync(500);

    expect(autosave.status.value.state).toBe("failed");
    expect(autosave.status.value.message).toContain("disk full");
    vi.useRealTimers();
  });

  it("reports saved after a successful write", async () => {
    vi.useFakeTimers();
    const autosave = createAutosave(vi.fn().mockResolvedValue(undefined), 500);
    autosave.schedule(file);
    await vi.advanceTimersByTimeAsync(500);
    expect(autosave.status.value.state).toBe("saved");
    vi.useRealTimers();
  });

  it("never runs two saves concurrently", async () => {
    // flush() clears the timer, but a debounced write may already be awaiting
    // save. Starting a second one issues two concurrent writes of the same
    // file — a wasted round trip, a stale-write race, and the exact
    // concurrency that corrupts the notes file.
    let concurrent = 0;
    let maxConcurrent = 0;
    const save = vi.fn().mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
    });

    const autosave = createAutosave(save, 0);
    autosave.schedule(file);
    await Promise.all([autosave.flush(), autosave.flush(), autosave.flush()]);

    expect(maxConcurrent).toBe(1);
  });

  it("flush writes immediately without waiting for the timer", async () => {
    // The dialog calls this on close, so a note typed a moment earlier is
    // not lost to a pending debounce.
    const save = vi.fn().mockResolvedValue(undefined);
    const autosave = createAutosave(save, 500);
    autosave.schedule(file);
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **Step 2: Run and watch it fail**

```bash
pnpm vitest run apps/desktop/src/components/docs/__tests__/docsAutosave.spec.ts
```
Expected: FAIL — cannot resolve `../docsAutosave`.

- [x] **Step 3: Implement `docsAutosave.ts`**

```ts
import { ref, type Ref } from "vue";
import type { AnnotationFile } from "@/docs/types";

export type SaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "failed"; message: string };

export interface Autosave {
  schedule: (file: AnnotationFile) => void;
  flush: () => Promise<void>;
  status: Ref<SaveStatus>;
}

/**
 * Debounced autosave.
 *
 * A failed write MUST become visible: the user keeps typing and believes
 * their notes are saved otherwise. The pending file is retained on failure so
 * the next edit retries rather than discarding what they wrote.
 */
export function createAutosave(save: (file: AnnotationFile) => Promise<void>, delayMs: number): Autosave {
  const status = ref<SaveStatus>({ state: "idle" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AnnotationFile | undefined;
  // The write currently in flight, if any. `flush()` clearing the timer is not
  // enough: a debounced write may already be awaiting `save`, and starting a
  // second one issues two concurrent saves of the same file. Beyond wasting a
  // round trip, the later one can land stale, and it is the exact concurrency
  // that corrupted the notes file before the Rust side used a unique temp path.
  let inFlight: Promise<void> | undefined;

  async function write(): Promise<void> {
    if (inFlight !== undefined) {
      // Wait for the current write, then run again if an edit arrived while it
      // was going — never two at once.
      await inFlight;
      if (pending === undefined) {
        return;
      }
    }
    if (pending === undefined) {
      return;
    }
    const file = pending;
    status.value = { state: "saving" };
    const attempt = (async () => {
      try {
        await save(file);
        // Only clear if no newer edit arrived while this was in flight.
        if (pending === file) {
          pending = undefined;
        }
        status.value = { state: "saved" };
      } catch (error) {
        status.value = { state: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    })();
    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) {
        inFlight = undefined;
      }
    }
  }

  return {
    status,
    schedule(file) {
      pending = file;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void write(), delayMs);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await write();
    },
  };
}
```

- [x] **Step 4: Run and watch it pass**

- [x] **Step 5: Build the dialog**

**The dialog shell, matching `SchemaDiagramDialog.vue` — the closest comparable feature:**

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DocsApp from "@/docs/DocsApp.vue";

const props = defineProps<{
  open: boolean;
  prefillConnectionId: string;
  prefillDatabase: string;
  prefillSchema?: string;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

// The get/set computed is how every dialog in this codebase bridges the
// `open` prop to `v-model:open` on <Dialog>.
const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

// This component lives OUTSIDE src/docs/, so it may and must use useI18n():
// it is what supplies the `translate` prop that the viewer components need,
// since they are banned from importing vue-i18n themselves.
const { t } = useI18n();
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent
      class="w-[94vw] max-w-[94vw] sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw] h-[86vh] max-h-[86vh] gap-0 p-0 overflow-hidden flex flex-col"
    >
      <DialogHeader>
        <DialogTitle>{{ t("docs.title") }}</DialogTitle>
      </DialogHeader>
      <!-- snapshot / annotations / translate / readonly=false down, `edit` up -->
    </DialogContent>
  </Dialog>
</template>
```

The sizing class is copied verbatim from `SchemaDiagramDialog.vue:827`. The docs viewer is the same
kind of thing — a full-window workspace rather than a form — so it should not invent its own
dimensions.


`DatabaseDocsDialog.vue` — props `open`, `prefillConnectionId`, `prefillDatabase`, `prefillSchema`. On open: `collectDocsSnapshot(...)` for the raw snapshot, `loadDocsAnnotations(...)` for the file (falling back to `emptyAnnotations()` when null), then `applyDocsAnnotations(...)` for what it displays. Holds the raw snapshot for re-derivation.

On an `edit` event from `DocsApp`: apply the matching `annotationEdits` function, `schedule` the autosave, and call `applyDocsAnnotations` to refresh the display. Show the save status. Call `flush()` before closing. Use `useI18n()` HERE — the dialog is outside `src/docs/` — and pass `t` down as the `translate` prop. Add a button opening the existing schema diagram via `connectionStore.diagramSource`.

- [x] **Step 6: Wire the trigger**

The schema diagram uses this exact five-point wiring. Mirror it — I verified every location:

1. **`apps/desktop/src/stores/connectionStore.ts:381`** — `diagramSource` is
   `ref<{ connectionId: string; database: string; schema?: string; tableName?: string } | null>(null)`,
   returned from the store at line 6928. Add `docsSource` with the same shape beside it, and export it
   the same way.

2. **`apps/desktop/src/composables/useDialogSources.ts` (~line 162)** — a `watch` on
   `connectionStore.diagramSource` copies the prefills, sets `showDiagramDialog.value = true`, then
   clears the source back to `null`. **Clearing it is what makes the dialog re-openable** — without
   that, setting the same value twice does not re-trigger the watcher. Add the docs equivalent.

3. **`apps/desktop/src/components/layout/AppDialogs.vue:13`** — `defineAsyncComponent(() => import(...))`,
   and **line 198** — rendered with `v-if="dialogs.showDiagramDialog.value"`,
   `v-model:open`, and the prefill props. Follow both.

4. **`apps/desktop/src/components/objects/ObjectBrowser.vue:1428`** — `openDiagram(row)` sets
   `connectionStore.diagramSource = { connectionId: props.connection.id, database: props.database,
   schema: row.schema || selectedSchema.value, tableName: ... }`. Add `openDocs(row)` the same way.

5. **`apps/desktop/src/components/objects/ObjectBrowser.vue:2605`** — the context-menu entry, shaped
   `...(canOpenDiagram.value ? [{ label: t("diagram.open"), action: () => openDiagram(row) }] : [])`.
   Add the docs entry beside it using `t("docs.title")` from the namespace Task 6 added.

**ObjectBrowser is the right entry point**, not the connection tree: the tree has no `diagram.open`
entry either, and the docs dialog takes exactly the prefills ObjectBrowser already supplies
(connection, database, schema). If a tree-level entry is wanted later it is one more call site
setting the same `docsSource`.

- [x] **Step 7: Verify two guards bite**

One at a time, restoring between each. Report both failure messages.

1. Make the `catch` in `write()` swallow its error (`catch { pending = undefined; }`) → `surfaces a failure instead of swallowing it` must fail.
2. Delete the `inFlight` guard at the top of `write()` → `never runs two saves concurrently` must fail.

- [x] **Step 8: Full verification and commit**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
pnpm vitest run apps/desktop/src
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs apps/desktop/src/components/docs
cargo test --workspace
git add apps/desktop/src src-tauri
git commit -m "feat(docs): mount the documentation viewer in DBX with autosaved editing"
```

---

## Done criteria

- Documentation opens from the connection tree, and edits to notes and group colours survive closing and reopening the dialog.
- Pointing `docs_notes_path` at a repository file produces a reviewable diff.
- `apps/desktop/src/docs/**/*.vue` still makes zero backend calls and persists nothing, enforced by the contract test.
- All 8 locales declare the same `docs` keys, enforced by a test.
- A failed save is visible and does not discard the user's work.
- `cargo test --workspace` and `pnpm vitest run apps/desktop/src` pass; `vue-tsc` and `oxlint` clean.

## Deferred to Part 3c

The standalone Vite bundle and self-contained HTML export; the `dbx docs` verb; hash routing; a minimal read-only ER renderer for the export; inlining `apps/desktop/public/fonts/geist-latin-wght-normal.woff2`; and closing the `DocEnum` fixture gap, since an exportable demo wants an enum-bearing schema anyway.
