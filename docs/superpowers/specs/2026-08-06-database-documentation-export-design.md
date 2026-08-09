# Standalone documentation export — design

**Part 3c of the database-documentation feature.** Parts 1, 2, 3a and 3b are complete on
`feature/docs-snapshot-dbml` and open upstream as PR #5559: `SchemaSnapshot` collection with a DBML
serializer and a `dbx dbml` verb, a file-backed annotation store, a pure Vue viewer, and that
viewer mounted in DBX with autosaved editing.

This part makes the documentation leave the application: one self-contained HTML file, produced by
a `dbx docs` verb and by a button in the app, that opens from `file://` on a machine with no DBX
installed.

## Goal

A user runs `dbx docs prod --out schema.html` in CI, or clicks **Export HTML** in the docs dialog,
and gets a single file they can commit, attach to a ticket, or email to a colleague. It opens with
no network, no server and no install. Deep links into it survive a reload, and the reader chooses
their own language.

## Scope

**In scope**

- A standalone Vite bundle of the existing viewer, built to one JS and one CSS
- `crates/dbx-core/src/docs/export.rs` — `to_standalone_html(snapshot, annotations, lang)`
- The `dbx docs` CLI verb, mirroring `dbx dbml`'s flags
- A Tauri command and an **Export HTML** button in `DatabaseDocsDialog.vue`
- Hash routing in the export shell, so `schema.html#/table/public.orders` is a link
- A language switcher over all 8 bundled `docs` namespaces
- `SchemaDiagram.vue` — a minimal read-only ER renderer
- A staleness guard so the committed bundle cannot drift from its sources

**Out of scope**

- Editing in the export. It is read-only; `readonly` exists on `DocsApp` for exactly this.
- Zoom, pan controls, drag, custom relationships or join-SQL in the diagram — that is what the
  full `SchemaDiagramDialog` is for.
- The `latin-ext` font subset. The latin subset is inlined; `latin-ext` doubles the font cost to
  serve characters most schemas never use, and the fallback is graceful.
- Persisting the reader's language choice. See "Language" below.

## Decisions taken before design

| Question | Decision |
|---|---|
| How does the built bundle reach the Rust binary? | Committed build artefact in `crates/dbx-core/assets/`, embedded with `include_str!`, with a staleness guard |
| Where does the ER renderer live? | `src/docs/`, with the host choosing the affordance |
| What language is the export? | All 8 namespaces bundled, switchable by the reader |
| Is there an in-app export button? | Yes — same Rust function, two callers |
| How is a stale bundle detected? | Content hash against a manifest, derived from the build |
| How is the payload embedded? | base64 |

## Architecture

### Three pieces, each with one job

```
apps/desktop/src/docs-export/          the export shell (browser)
  main.ts          mounts ExportApp, decodes the payload
  ExportApp.vue    hash routing, language switcher, readonly=true, diagram="inline"
  export.css       @source narrowed to ../docs/** + inlined @font-face

pnpm build:docs-export                 vite.docs-export.config.ts
  → one JS, one CSS, font as data URI, no code splitting
  → crates/dbx-core/assets/docs-export.{js,css,manifest.json}

crates/dbx-core/src/docs/export.rs     to_standalone_html(snapshot, annotations, lang)
  → include_str! the two assets, base64 the payload, emit one HTML file
```

### Why the bundle is committed rather than built by cargo

Rust cannot run Vite, and `dbx docs` must work from a plain `cargo install` on a machine with no
Node. A `build.rs` that shells out to pnpm would break exactly that case, and neither existing
`build.rs` invokes an external toolchain.

There is partial precedent: `crates/dbx-core/src/ai_pi_agent_cli.rs:24` embeds
`include_str!("../assets/pi-mcp-bridge.mjs")`, and `crates/dbx-core/assets/` already carries a
54.8 KB driver manifest. The caveat is honest and belongs in the PR: `pi-mcp-bridge.mjs` is
hand-written, so the precedent covers committing a *source* asset, not a *build artefact*. The
staleness guard is what makes the difference acceptable.

### Data flow

`dbx docs` collects a snapshot exactly as `dbx dbml` does — same collector, same `--schema`,
`--database`, `--tables`, `--notes` flags, same warnings on stderr through the `Display` impl. It
then calls `to_standalone_html`. The Tauri command calls the identical function.

The snapshot is passed **with annotations already applied**, because `apply_annotations` is Rust
and the export has no Rust at runtime. The raw `AnnotationFile` also travels, for the same reason
the dialog needs it: `snapshot.groups` holds resolved `TableGroup`s, while `annotations.groups`
holds the `GroupAnnotation` records that carry each group's hue.

### The payload is base64

The exported page contains user-authored Markdown. A note containing the literal text `</script>`
— entirely plausible in a schema document that discusses HTML — would terminate the script element
early and inject the remainder as markup.

base64 removes the problem structurally rather than procedurally: the alphabet is `A-Za-z0-9+/=`,
so no escaping rule exists to forget, and the property is auditable by inspection instead of by
reviewing every serialization path. It costs +33% on the JSON only.

The alternatives were considered and rejected. A `<script type="application/json">` in which every
`<` is rewritten as its JSON unicode escape (backslash, `u`, `003c`) is what SSR frameworks do and
is sound, but its correctness depends on that rewrite being applied on every path. A JS string literal needs four independent escaping rules —
quotes, backslashes, `</script>`, and U+2028/U+2029, which `JSON.stringify` emits raw because they
are valid JSON but which were line terminators inside JS string literals until ES2019.

The cost of base64 is that the embedded schema is no longer readable in a text editor. That is
accepted.

### Styling: `globals.css` cannot be reused

Two facts decide this.

`apps/desktop/src/styles/globals.css:40` is `@source "../**/*.{vue,ts,tsx,js,jsx,html}"`. Tailwind
v4 scans the entire application, so importing `globals.css` into the export would emit every
utility used anywhere in DBX. The 76 KB of source is not the cost; the generated utility surface
is. `@source` is additive — there is no way to un-source it.

Its four `@font-face` blocks use absolute `/fonts/…` URLs, which under `file://` resolve against
the filesystem root and fail silently to a system font.

So `export.css` is its own entry: `@source` narrowed to `../docs/**`, and `@font-face` redeclared
with the woff2 inlined as a data URI (~38 KB base64).

### One shared-file change: `tokens.css`

The viewer's utilities resolve against tokens — `--background`, `--foreground`,
`--muted-foreground`, `--border`, `--ring` — defined in `globals.css` from line 131, interleaved
with roughly 2300 lines of application-specific rules. A narrowed `@source` still needs those
tokens.

The token blocks move to `apps/desktop/src/styles/tokens.css`, imported by **both** `globals.css`
and `export.css`. One definition, no drift. Copying the values into the export instead is exactly
the duplication that produced this feature's recurring defects.

**This is a real risk and the plan must treat it as one.** It edits a 76 KB stylesheet the whole
application depends on, on an already-large branch. The move is mechanical — a contiguous block
plus one `@import` — but the cascade order between `:root` and `.dark` must be preserved exactly.
A test asserts every custom property defined at `:root` before the extraction still resolves after
it.

## The export shell

### Hash routing stays out of the shared tree

`DocsApp` owns navigation internally today: `activeKey`, `activeEnumName`, and a computed
`view: "index" | "table" | "enum"`. It gains an **optional** `v-model:route`:

```ts
type DocsRoute =
  | { kind: "index" }
  | { kind: "table"; key: string }
  | { kind: "enum"; name: string }
  | { kind: "diagram" };
```

Absent, `DocsApp` behaves exactly as it does today and the dialog is untouched. Present, the shell
controls navigation and mirrors `location.hash`.

`{ kind: "diagram" }` is only reachable when `diagram="inline"`. Under `diagram="external"` the
route resolves to the index, so a hash of `#/diagram` in the dialog's context cannot render a view
that host has deliberately not enabled.

This separation is not stylistic. DBX has **no router at all** — `vue-router` is not a dependency,
and the only `location.hash` reference in the frontend is a debug logger at
`lib/backend/debugLog.ts:214`. A `DocsApp` that wrote to the URL would hijack the host
application's address bar.

Hash grammar, with `encodeURIComponent` on the identifier so a table named `a/b` round-trips:

```
#/                          index
#/table/public.orders       table page
#/enum/order_status         enum page
#/diagram                   ER diagram
```

Hash routing rather than `pushState` because the target is `file://`, where `pushState` is
unusable but a fragment survives a reload and makes `schema.html#/table/public.orders` a link
worth pasting.

**Parsing is defensive by contract.** An unparseable hash, or one naming a table or enum absent
from the payload, resolves to the index. A stale deep link into a since-dropped table is the
expected case, not an exotic one, and must never produce a blank page.

### Language

All 8 `docs` namespaces are bundled. They total 15,197 bytes of source across
`apps/desktop/src/i18n/locales/docs/{en,es,it,ja,ko,pt-BR,zh-CN,zh-TW}.ts` — roughly 3 KB gzipped,
negligible against the bundle. The payload carries an initial `lang` from `--lang` or the app's
current locale; the switcher rebuilds `translate` from the bundled namespace.

**No persistence.** Under `file://` every document shares one opaque origin, so `localStorage`
would leak one export's preference into an unrelated one. A single-session document is the honest
model.

**Missing keys fall back to English.** The parity test guarantees all 8 namespaces agree, so this
should never fire; it exists so an artefact opened offline degrades to English rather than
rendering a raw key. This does not repeat the Part 3b hazard where a fallback masked drift — there
the fallback replaced the guard, here the guard runs in CI and the fallback is a runtime backstop.

The switcher is worth having because **the reader is usually not the exporter**: the file gets
sent to someone else, and upstream's largest user base does not read English.

### The ER renderer

`SchemaDiagram.vue` lives in `src/docs/` and is added to the contract test's expected component
list. It imports `layoutDiagramTables` from `@/lib/diagram/erDiagram` — permitted, since only
`@/lib/backend` is forbidden, and that module has exactly one import which is `import type`,
making it fully bundleable.

So the grid layout is reused, not reinvented. What is genuinely new is **edge routing**, which
exists nowhere in the codebase today: a straight line between two cards' centres, clipped at each
card's border so it terminates on the edge rather than under the box. Crossings are tolerated.

Deliberately minimal: SVG at natural size inside an `overflow: auto` container, because scrolling
*is* panning. No zoom, no drag, no custom relationships, no join-SQL. Group colours come from
`groupStyle(hue)` so the diagram agrees with the wiki, and clicking a table navigates to its page —
which under hash routing makes the diagram a usable table of contents.

The host chooses the affordance. `DatabaseDocsDialog` passes `diagram="external"` and keeps its
existing button to the full `SchemaDiagramDialog`; the export passes `diagram="inline"`. No screen
shows both, and neither host gets a worse diagram than it could have.

## The staleness guard

`pnpm build:docs-export` emits `docs-export.js`, `docs-export.css` and `docs-export.manifest.json`
into `crates/dbx-core/assets/`.

**The manifest is derived from Rollup's module graph, not from a hand-written glob.** This is the
single most important detail in this section. `SchemaDiagram.vue` imports `erDiagram.ts`, which
lives outside `src/docs/` — a glob of `src/docs/**` would miss it and the guard would pass while
the artefact was stale. That is the same defect shape that has now bitten this feature three times:
`vue-i18n` absent from the contract test's forbidden list, `DocEnum` unpinned by an enum-free
fixture, `.docs-ground-light` absent from the CSS selector list. **A guard that enumerates its
targets silently excludes everything added later.**

So the build script writes the manifest from every repo file that actually entered the bundle,
plus the resolved versions of the node_modules packages it pulled in.

This closes the loop on new files, and the reason should be stated in the plan rather than left
implied: a new module can only enter the bundle by being imported, which means editing an existing
file, which changes that file's hash. The one hole is `import.meta.glob`, which would add modules
without editing an importer — the viewer does not use it, and the plan says so explicitly.

The Rust test recomputes the hashes and fails with the regeneration command. It must skip when the
crate is consumed from a published package where `apps/desktop/` does not exist — and that skip is
itself a hazard, since a vacuous skip in CI would silently disable the guard. The skip therefore
keys off a repository-only marker (`pnpm-workspace.yaml`): marker present, the test runs; marker
absent, the crate is genuinely packaged and there is nothing to check.

## Error handling

- `--out` omitted writes to stdout, matching `dbx dbml`. A 400 KB HTML in a terminal is unpleasant,
  but consistency and `dbx docs prod | gzip > docs.html.gz` are worth more than a special case.
- `--lang xx` fails with the list of valid locales rather than falling back. A typo should be loud,
  the same reasoning that made `--notes` an explicit flag in Part 2.
- A missing or malformed notes file behaves exactly as `dbx dbml` does, through the existing
  `require_notes_file`.

## Testing

| Layer | Approach |
|---|---|
| `to_standalone_html` | Rust: base64 round-trip; a note containing `</script>` survives intact |
| Self-containedness | Rust: the emitted HTML contains no `http://`, `https://`, `url(/`, or external `src`/`href` |
| Route parsing | TS: pure parse/format — unknown table resolves to index, encoded identifiers, empty hash |
| Language | TS: the translate factory picks the right namespace; unknown lang falls back to English |
| Edge clipping | TS: the line-to-card-border intersection is a pure function |
| Contract | `SchemaDiagram.vue` added to the expected component list |
| Token extraction | Every custom property defined at `:root` before the move still resolves after it |
| Staleness | The manifest test, verified by touching a source file and watching it fail |

**Every new test gets the deliberate-break treatment**: break the behaviour, watch the named test
fail, restore, report the failure message. Across Parts 3a and 3b this caught a vacuous ranking
test, a CSS ordering bug that let a whole theme's colours be deleted silently, a capability warning
that contradicted its own data, and an atomicity test that was vacuous because of the fix
instruction I had written myself.

### The test worth attempting but not promising

A `happy-dom` smoke test that loads the generated HTML, executes the inline bundle, and asserts a
known table name reaches the DOM is the only test that proves the artefact *works* rather than
merely looks right. `happy-dom ^20.10.6` is already a dependency; Playwright and Puppeteer are not.

happy-dom can execute scripts, but running a full Vue bundle in it is not guaranteed. If it works
it is the most valuable test in this part. If it does not, the plan says so plainly and falls back
to the structural self-containedness test plus opening the file in a real browser over `file://` —
the method already used to verify the viewer for PR #5559's screenshots.

## Success criteria

- `dbx docs prod --out schema.html` produces one file that opens from `file://` with no network, no
  server and no DBX installed.
- `schema.html#/table/public.orders` survives a reload and can be pasted to a colleague.
- A reader switches language without re-exporting.
- The in-app button and the CLI produce byte-identical output for the same inputs, because they
  call the same function.
- The committed bundle cannot drift from its sources without a test failing.
- `apps/desktop/src/docs/**/*.vue` still makes zero backend calls, enforced by the contract test.
