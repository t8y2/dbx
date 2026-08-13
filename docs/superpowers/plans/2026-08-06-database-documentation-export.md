# Standalone Documentation Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one self-contained HTML file — from a `dbx docs` CLI verb and from a button in the app — that renders a database's documentation from `file://` on a machine with no DBX installed.

**Architecture:** The existing pure viewer under `apps/desktop/src/docs/` is bundled by a dedicated Vite entry into one JS and one CSS file, committed into `crates/dbx-core/assets/` and embedded with `include_str!`. A Rust function `to_standalone_html` base64-encodes the snapshot payload and emits the HTML; the CLI and a Tauri command both call it. A build-derived manifest makes the committed artefact unable to drift from its sources without a test failing.

**Tech Stack:** Rust (dbx-core, dbx-cli, Tauri), Vue 3.5 `<script setup lang="ts">`, Vite 8, Tailwind v4, vitest 4 + happy-dom 20, `base64 0.22` and `sha2 0.10` (both already dbx-core dependencies).

## Global Constraints

- **No new dependencies.** `base64 0.22` and `sha2 0.10` are already in `crates/dbx-core/Cargo.toml` (lines 61 and 67). `happy-dom ^20.10.6` is already a devDependency. Adding anything else requires explicit approval.
- **`apps/desktop/src/docs/**/*.vue` must make zero backend calls.** Enforced by `apps/desktop/src/docs/__tests__/componentContract.spec.ts`, whose forbidden list is `["@/lib/backend", "@tauri-apps", "invoke(", "useConnectionStore", "useQueryStore", "useSettingsStore", "fetch(", "axios", "vue-i18n", "useI18n("]`. Extend it; never weaken it.
- **Every component uses `<script setup lang="ts">`.** Asserted by the same contract test.
- **No colour computed in a component.** `oklch(` and 6-digit hex literals are banned in `src/docs/**`; hues go through `groupStyle(hue)` from `apps/desktop/src/docs/groupColor.ts`.
- **`v-html` may only ever be bound to `renderNote` output.** Both quote styles are checked; `innerHTML` is banned outright.
- **All 8 locales.** `en`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-CN`, `zh-TW` in `apps/desktop/src/i18n/locales/docs/`. Parity is enforced by `apps/desktop/src/i18n/__tests__/docsNamespaceParity.spec.ts`.
- **Tests live at** `apps/desktop/src/**/*.spec.ts` (vitest `include` at `vitest.config.ts:14`). Run one with `pnpm vitest run <path> -t "<test name>"`.
- **Rust docs tests** run with `cargo test -p dbx-core --lib docs`.
- **Every new test gets the deliberate-break treatment:** break the behaviour, run the named test, confirm it fails, restore, and report the exact failure message in the task report. Parts 3a and 3b caught four defects this way that no amount of reading found.
- **Commit after every task.** Conventional Commits. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
  ```

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/desktop/src/docs/docsRoute.ts` | Pure parse/format between a hash string and `DocsRoute` |
| `apps/desktop/src/docs/diagramGeometry.ts` | Pure edge clipping — line from card centre to card border |
| `apps/desktop/src/docs/components/SchemaDiagram.vue` | Minimal read-only SVG ER renderer |
| `apps/desktop/src/docs-export/main.ts` | Export entry: decode payload, mount `ExportApp` |
| `apps/desktop/src/docs-export/ExportApp.vue` | Export shell: hash sync, language switcher, `readonly`, `diagram="inline"` |
| `apps/desktop/src/docs-export/exportTranslate.ts` | Build a `Translate` from a bundled locale, English fallback |
| `apps/desktop/src/docs-export/export.css` | Tailwind entry with `@source` narrowed to `../docs/**` |
| `apps/desktop/src/styles/tokens.css` | Design tokens extracted from `globals.css` |
| `apps/desktop/vite.docs-export.config.ts` | Single-file bundle config, font inlining, manifest emission |
| `crates/dbx-core/src/docs/export.rs` | `to_standalone_html` + the staleness guard test |
| `src-tauri/src/commands/docs.rs` (modify) | `docs_export_html` command |

**Modified**

| Path | Change |
|---|---|
| `apps/desktop/src/docs/DocsApp.vue` | Optional `v-model:route`, `diagram` prop, translate its own literals |
| `apps/desktop/src/docs/components/{DocsSidebar,DocsSearch,TablePage,ColumnTable,RelationshipList}.vue` | Accept and use `translate` |
| `apps/desktop/src/i18n/locales/docs/*.ts` (×8) | ~18 new keys |
| `apps/desktop/src/docs/__tests__/componentContract.spec.ts` | Add `SchemaDiagram.vue`; add the hardcoded-literal guard |
| `apps/desktop/src/styles/globals.css` | Token blocks replaced by `@import "./tokens.css"` |
| `crates/dbx-core/src/docs/mod.rs` | `pub mod export;` + re-export |
| `crates/dbx-cli/src/main.rs` | `--lang` flag, `run_docs`, usage line |
| `apps/desktop/src/lib/backend/{api,tauri,http}.ts` | `exportDocsHtml` |
| `apps/desktop/src/components/docs/DatabaseDocsDialog.vue` | Export HTML button |
| `crates/dbx-web/src/{main.rs,routes/docs.rs}` | `/docs/export` route |
| `package.json` | `build:docs-export` script |

---

## Task 1: Internationalise the viewer

The `docs` namespace has 40 keys across 8 locales and a passing parity test, but most of the viewer renders English literals instead of calling them. `groupBySchema: "Schemas"` and `groupByTableGroup: "Table Groups"` exist *specifically* for `DocsSidebar.vue`, which hardcodes both words.

This is a prerequisite: a language switcher over a viewer that is two-thirds hardcoded English would be worse than none. It is also a live defect in the open PR — a Chinese user opening the docs dialog today sees mostly English chrome.

**Files:**
- Modify: `apps/desktop/src/docs/DocsApp.vue`
- Modify: `apps/desktop/src/docs/components/DocsSidebar.vue`
- Modify: `apps/desktop/src/docs/components/DocsSearch.vue`
- Modify: `apps/desktop/src/docs/components/TablePage.vue`
- Modify: `apps/desktop/src/docs/components/ColumnTable.vue`
- Modify: `apps/desktop/src/docs/components/RelationshipList.vue`
- Modify: `apps/desktop/src/i18n/locales/docs/{en,es,it,ja,ko,pt-BR,zh-CN,zh-TW}.ts`
- Test: `apps/desktop/src/docs/__tests__/componentContract.spec.ts`

**Interfaces:**
- Consumes: `Translate` from `apps/desktop/src/docs/docsWarnings.ts` — exactly `export type Translate = (key: string, params?: Record<string, string | number>) => string;`
- Produces: every component under `src/docs/` accepts a required `translate: Translate` prop. Later tasks rely on `DocsSidebar` and `SchemaDiagram` having it.

**Keys already present — wire these, do not re-add:** `groupBySchema`, `groupByTableGroup`, `search`, `columns`, `indexes`, `references`, `referencedBy`, `noGroup`, `noSchema`.

Leave the existing `search` value (`"Search tables, columns, groups…"`) unchanged even though search now also covers enums. Rewording one clause across 8 locales invites translation drift for negligible gain, and results are already labelled by kind.

- [ ] **Step 1: Write the failing guard test**

Append to `apps/desktop/src/docs/__tests__/componentContract.spec.ts`, inside the existing `describe`:

```ts
  it("renders no English literal that already has a key", async () => {
    // Derived from the namespace, NOT an enumerated list of strings. A key
    // added tomorrow is covered tomorrow. This is the guard Part 3b lacked:
    // docsNamespaceParity compares locale files to EACH OTHER, so a key that
    // no component ever calls passes every existing test.
    const en = (await import("../../i18n/locales/docs/en")).default as Record<string, unknown>;
    const literals: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string") {
        // Skip short strings (false positives on words like "LOCAL") and any
        // string carrying a placeholder, which cannot appear verbatim anyway.
        if (node.length >= 4 && !node.includes("{")) literals.push(node);
        return;
      }
      if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(en);
    expect(literals.length).toBeGreaterThan(10);

    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const literal of literals) {
        expect(source.includes(`>${literal}<`), `${path.basename(file)} hardcodes "${literal}" — call translate() instead`).toBe(false);
        expect(source.includes(`="${literal}"`), `${path.basename(file)} hardcodes "${literal}" — call translate() instead`).toBe(false);
      }
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/componentContract.spec.ts -t "renders no English literal"`

Expected: FAIL. `DocsSidebar.vue hardcodes "Schemas" — call translate() instead: expected true to be false` (or another of the six components; any one failing is the correct starting state).

- [ ] **Step 3: Add the new keys to `en.ts`**

Insert into `apps/desktop/src/i18n/locales/docs/en.ts` before the `warnings:` block:

```ts
  overview: "Overview",
  groupBy: "Group by",
  searchLabel: "Search",
  groups: "Groups",
  relationships: "Relationships",
  columnHeader: "Column",
  typeHeader: "Type",
  settingsHeader: "Settings",
  noteHeader: "Note",
  nameHeader: "Name",
  definitionHeader: "Definition",
  noOutgoingRelationships: "This table references no other table.",
  noIncomingRelationships: "No table references this one.",
  diagram: "Diagram",
  language: "Language",
  exportHtml: "Export HTML…",
  exporting: "Exporting…",
  exportFailed: "Could not export: {error}",
```

- [ ] **Step 4: Translate the 18 new keys into the other 7 locales**

Add the same 18 keys to `es.ts`, `it.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `zh-CN.ts`, `zh-TW.ts`, matching each file's existing tone and terminology.

**`{error}` must survive verbatim in every locale.** The Part 3b review caught that no automated test verifies placeholder preservation — parity compares key *names*, so a translated or renamed `{error}` would render literal braces to users and pass every test. Check each one by eye.

- [ ] **Step 5: Wire `DocsSidebar.vue`**

Add to its `defineProps`: `translate: Translate;` with `import type { Translate } from "../docsWarnings";`. Then replace the four literals:

```
>Overview<              → >{{ translate("docs.overview") }}<
>Group by<              → >{{ translate("docs.groupBy") }}<
>Schemas<               → >{{ translate("docs.groupBySchema") }}<
>Table Groups<          → >{{ translate("docs.groupByTableGroup") }}<
```

- [ ] **Step 6: Wire the remaining five components**

`DocsSearch.vue` — add the `translate` prop; `>Search<` becomes `{{ translate("docs.searchLabel") }}`, and `placeholder="Search tables, columns, groups, enums…"` becomes `:placeholder='translate("docs.search")'`.

`TablePage.vue` — already receives `translate` and passes it down; now use it for its own headings: `Columns` → `docs.columns`, `Indexes` → `docs.indexes`, `Relationships` → `docs.relationships`, `Name` → `docs.nameHeader`, `Settings` → `docs.settingsHeader`, `Definition` → `docs.definitionHeader`.

`ColumnTable.vue` — headers `Column` → `docs.columnHeader`, `Type` → `docs.typeHeader`, `Settings` → `docs.settingsHeader`, `Note` → `docs.noteHeader`.

`RelationshipList.vue` — add the `translate` prop and thread it from `TablePage.vue`:

```
>References ({{ outgoing.length }})<     → >{{ translate("docs.references") }} ({{ outgoing.length }})<
>Referenced by ({{ incoming.length }})<  → >{{ translate("docs.referencedBy") }} ({{ incoming.length }})<
>This table references no other table.<  → >{{ translate("docs.noOutgoingRelationships") }}<
>No table references this one.<          → >{{ translate("docs.noIncomingRelationships") }}<
```

`DocsApp.vue` — `>Groups<` becomes `{{ translate("docs.groups") }}`.

- [ ] **Step 7: Run the guard, the parity test and typecheck**

Run: `pnpm vitest run apps/desktop/src/docs apps/desktop/src/i18n`
Expected: PASS, with the new guard among them.

Run: `pnpm typecheck`
Expected: clean. A missing `translate` prop on a threaded component fails here.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/docs apps/desktop/src/i18n
git commit -m "$(cat <<'EOF'
fix(docs): translate the viewer's own chrome

The docs namespace has carried 40 keys across 8 locales since Part 3b, with
a parity test that passes — but most components rendered English literals
instead of calling them. `groupBySchema: "Schemas"` existed specifically for
DocsSidebar, which hardcoded the word.

Parity compares locale files to each other, so a key no component ever calls
is invisible to it. The new guard derives its forbidden literals FROM the
English namespace, so a key added later is covered without anyone
remembering to register it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 2: Extract the design tokens

The export's Tailwind entry cannot import `globals.css`: line 40 is `@source "../**/*.{vue,ts,tsx,js,jsx,html}"`, which scans the whole application, and `@source` is additive with no way to un-source. But the viewer's utilities still resolve against tokens defined in `globals.css` from line 131.

**Files:**
- Create: `apps/desktop/src/styles/tokens.css`
- Modify: `apps/desktop/src/styles/globals.css`
- Test: `apps/desktop/src/docs/__tests__/tokens.spec.ts`

**Interfaces:**
- Produces: `apps/desktop/src/styles/tokens.css`, importable by both `globals.css` and (Task 5) `export.css`.

This edits a 76 KB stylesheet the whole application depends on. The move is mechanical, but **cascade order between `:root` and `.dark` must be preserved exactly** — `.dark` must still be declared after `:root`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/docs/__tests__/tokens.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(__dirname, "../../styles");

/** Every `--name:` custom property declared in a stylesheet. */
function declaredTokens(file: string): Set<string> {
  const source = readFileSync(path.join(stylesDir, file), "utf8");
  return new Set(Array.from(source.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (match) => match[1]));
}

describe("design tokens", () => {
  it("defines the tokens the docs viewer resolves against", () => {
    // These are the utilities used in src/docs/**: bg-background,
    // text-foreground, text-muted-foreground, bg-muted, border-border,
    // focus:border-ring. If a token stops being declared here the export
    // renders unstyled while the app, which has globals.css, looks fine —
    // so this must be checked against tokens.css, not globals.css.
    const tokens = declaredTokens("tokens.css");
    for (const token of ["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--ring"]) {
      expect(tokens.has(token), `tokens.css must declare ${token}`).toBe(true);
    }
  });

  it("keeps globals.css importing the extracted tokens", () => {
    const globals = readFileSync(path.join(stylesDir, "globals.css"), "utf8");
    expect(globals.includes('@import "./tokens.css"')).toBe(true);
  });

  it("declares the dark overrides after the light ones", () => {
    // Custom properties resolve at use time, but override order still
    // decides which block wins. A tokens.css with .dark BEFORE :root leaves
    // dark mode rendering light values.
    const source = readFileSync(path.join(stylesDir, "tokens.css"), "utf8");
    const root = source.search(/^:root\s*\{/m);
    const dark = source.search(/^\.dark\s*\{/m);
    expect(root, "tokens.css must declare :root").toBeGreaterThan(-1);
    expect(dark, "tokens.css must declare .dark").toBeGreaterThan(-1);
    expect(dark).toBeGreaterThan(root);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/tokens.spec.ts`
Expected: FAIL — `ENOENT: no such file or directory, open '.../styles/tokens.css'`.

- [ ] **Step 3: Move the token blocks**

Read `apps/desktop/src/styles/globals.css` and find the `:root { … }` block starting at line 131 and its corresponding `.dark { … }` block. Cut both **verbatim** into a new `apps/desktop/src/styles/tokens.css` with this header:

```css
/*
 * Design tokens, shared by the application shell and the standalone
 * documentation export.
 *
 * These live apart from globals.css because the export's Tailwind entry
 * cannot import globals.css: its `@source` scans the whole application and
 * `@source` is additive, so the export would emit every utility in DBX. The
 * export still needs these tokens, and duplicating them is how the values
 * drift.
 *
 * Order matters: `.dark` must stay declared after `:root`.
 */
```

Do not reformat, reorder or "tidy" the declarations while moving them — a diff that is a pure move is reviewable; one that also reformats is not.

- [ ] **Step 4: Import from globals.css**

At the point in `globals.css` where the `:root` block used to begin, put:

```css
@import "./tokens.css";
```

Leave `@theme inline` (line 71) and the `@import "tailwindcss"` / `@source` lines exactly where they are.

- [ ] **Step 5: Verify the application is unchanged**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/tokens.spec.ts`
Expected: PASS (all three).

Run: `pnpm build`
Expected: succeeds. Then confirm the built CSS still carries the tokens:

```bash
grep -c -- "--muted-foreground" dist/assets/*.css
```
Expected: at least 1. A zero here means the `@import` did not resolve and the whole application would render unstyled.

- [ ] **Step 6: Deliberate break**

Reorder `tokens.css` so `.dark` precedes `:root`. Run the test; confirm it fails with `expected <n> to be greater than <m>`. Restore. Report the message.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/styles apps/desktop/src/docs/__tests__/tokens.spec.ts
git commit -m "$(cat <<'EOF'
refactor(styles): extract design tokens for reuse by the export

The standalone export's Tailwind entry cannot import globals.css — its
`@source` scans the whole application and `@source` is additive, so the
export would emit every utility in DBX rather than the ~40 the viewer uses.

The tokens move verbatim; globals.css imports them. Copying the values into
the export instead is exactly the duplication that has produced this
feature's recurring defects.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 3: `DocsRoute` and optional `v-model:route`

**Files:**
- Create: `apps/desktop/src/docs/docsRoute.ts`
- Create: `apps/desktop/src/docs/__tests__/docsRoute.spec.ts`
- Modify: `apps/desktop/src/docs/DocsApp.vue`

**Interfaces:**
- Produces: `export type DocsRoute`, `export function parseDocsHash(hash: string, snapshot: SchemaSnapshot, allowDiagram: boolean): DocsRoute`, `export function formatDocsHash(route: DocsRoute): string`. Task 5's `ExportApp.vue` consumes both.
- Produces: `DocsApp` accepts optional `route?: DocsRoute` and emits `update:route`.

`DocsApp` must stay uncontrolled when `route` is absent — DBX has no router (`vue-router` is not a dependency), so a `DocsApp` that always wrote to the URL would hijack the host application's address bar.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/docs/__tests__/docsRoute.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatDocsHash, parseDocsHash } from "../docsRoute";
import type { SchemaSnapshot } from "../types";

// `formatVersion` is top-level on SchemaSnapshot, not inside `project`.
const snapshot = {
  formatVersion: 1,
  project: { name: "shop", databaseType: "postgres", database: "shop", schemas: ["public"], generatedAt: "2026-08-06T00:00:00Z", note: null },
  tables: [{ schema: "public", name: "orders", columns: [], indexes: [] }, { schema: null, name: "a/b", columns: [], indexes: [] }],
  enums: [{ schema: "public", name: "order_status", values: ["pending"] }],
  relationships: [],
  groups: [],
  warnings: [],
} as unknown as SchemaSnapshot;

describe("parseDocsHash", () => {
  it("reads a table route", () => {
    expect(parseDocsHash("#/table/public.orders", snapshot, true)).toEqual({ kind: "table", key: "public.orders" });
  });

  it("decodes an identifier containing a slash", () => {
    // A table named `a/b` must survive the round trip; an undecoded hash
    // would split into a bogus segment and silently fall back to the index.
    expect(parseDocsHash("#/table/a%2Fb", snapshot, true)).toEqual({ kind: "table", key: "a/b" });
  });

  it("reads an enum route", () => {
    expect(parseDocsHash("#/enum/order_status", snapshot, true)).toEqual({ kind: "enum", name: "order_status" });
  });

  it("falls back to the index for a table that is not in the snapshot", () => {
    // A deep link into a since-dropped table is the EXPECTED case for a file
    // someone saved months ago. It must never render a blank page.
    expect(parseDocsHash("#/table/public.gone", snapshot, true)).toEqual({ kind: "index" });
  });

  it("falls back to the index for junk, empty and bare hashes", () => {
    for (const hash of ["", "#", "#/", "#/nonsense", "#/table", "#/table/", "not-a-hash"]) {
      expect(parseDocsHash(hash, snapshot, true), hash).toEqual({ kind: "index" });
    }
  });

  it("refuses the diagram route when the host has not enabled it", () => {
    // The dialog passes diagram="external" and keeps its button to the full
    // SchemaDiagramDialog. A hash must not render a view that host declined.
    expect(parseDocsHash("#/diagram", snapshot, false)).toEqual({ kind: "index" });
    expect(parseDocsHash("#/diagram", snapshot, true)).toEqual({ kind: "diagram" });
  });
});

describe("formatDocsHash", () => {
  it("round-trips every route kind", () => {
    for (const route of [{ kind: "index" }, { kind: "table", key: "public.orders" }, { kind: "enum", name: "order_status" }, { kind: "diagram" }] as const) {
      expect(parseDocsHash(formatDocsHash(route), snapshot, true)).toEqual(route);
    }
  });

  it("encodes a slash in an identifier", () => {
    expect(formatDocsHash({ kind: "table", key: "a/b" })).toBe("#/table/a%2Fb");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/docsRoute.spec.ts`
Expected: FAIL — `Failed to resolve import "../docsRoute"`.

- [ ] **Step 3: Implement `docsRoute.ts`**

```ts
import { qualifiedTableKey } from "./docsKeys";
import type { SchemaSnapshot } from "./types";

/**
 * Where the viewer is pointing.
 *
 * This exists so the standalone export can drive navigation from
 * `location.hash` without DocsApp itself touching the URL: DBX has no
 * router, and a viewer that wrote to the address bar would hijack the host
 * application's.
 */
export type DocsRoute = { kind: "index" } | { kind: "table"; key: string } | { kind: "enum"; name: string } | { kind: "diagram" };

const INDEX: DocsRoute = { kind: "index" };

/**
 * Resolve a hash against a snapshot.
 *
 * Anything unrecognised — junk, a table that no longer exists, the diagram
 * route on a host that did not enable it — resolves to the index. A saved
 * file whose schema has since changed is the expected case, not an exotic
 * one, and must never render blank.
 */
export function parseDocsHash(hash: string, snapshot: SchemaSnapshot, allowDiagram: boolean): DocsRoute {
  if (!hash.startsWith("#")) return INDEX;
  const segments = hash.slice(1).replace(/^\//, "").split("/");
  const [kind, ...rest] = segments;
  const identifier = rest.join("/");

  if (kind === "diagram" && identifier === "") return allowDiagram ? { kind: "diagram" } : INDEX;

  if (identifier === "") return INDEX;
  let decoded: string;
  try {
    decoded = decodeURIComponent(identifier);
  } catch {
    // A malformed percent-escape throws rather than returning null.
    return INDEX;
  }

  if (kind === "table") {
    return snapshot.tables.some((table) => qualifiedTableKey(table) === decoded) ? { kind: "table", key: decoded } : INDEX;
  }
  if (kind === "enum") {
    return (snapshot.enums ?? []).some((value) => value.name === decoded) ? { kind: "enum", name: decoded } : INDEX;
  }
  return INDEX;
}

export function formatDocsHash(route: DocsRoute): string {
  switch (route.kind) {
    case "table":
      return `#/table/${encodeURIComponent(route.key)}`;
    case "enum":
      return `#/enum/${encodeURIComponent(route.name)}`;
    case "diagram":
      return "#/diagram";
    default:
      return "#/";
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/docsRoute.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Make `DocsApp` optionally controlled**

In `apps/desktop/src/docs/DocsApp.vue`, add to `defineProps`:

```ts
  /**
   * When provided, navigation is controlled by the host and mirrored back
   * through `update:route`. Absent — the dialog's case — DocsApp owns its
   * own navigation exactly as before and never touches the URL.
   */
  route?: DocsRoute;
  /** `inline` renders SchemaDiagram; `external` leaves the host to offer its own. */
  diagram?: "inline" | "external";
```

Add `"update:route": [route: DocsRoute]` to `defineEmits`. Replace the internal `activeKey` / `activeEnumName` reads with a computed that prefers `props.route` when present, and have `open()` / `home()` / `openEnum()` emit `update:route` in addition to setting internal state. Default `diagram` to `"external"`.

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm vitest run apps/desktop/src/docs && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Deliberate break**

Change `parseDocsHash` to return `{ kind: "table", key: decoded }` without the `snapshot.tables.some(...)` check. Run the test; confirm `falls back to the index for a table that is not in the snapshot` fails. Restore. Report the message.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/docs
git commit -m "$(cat <<'EOF'
feat(docs): add a route model the export can drive from the URL

DocsApp gains an OPTIONAL v-model:route. Absent, it owns navigation exactly
as before — which is what the in-app dialog needs, since DBX has no router
and a viewer that wrote to location.hash would hijack the host's address bar.

Parsing is total: junk, a dropped table, or the diagram route on a host that
did not enable it all resolve to the index. A deep link into a file saved
months ago is the expected case, not an exotic one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 4: The minimal ER renderer

**Files:**
- Create: `apps/desktop/src/docs/diagramGeometry.ts`
- Create: `apps/desktop/src/docs/__tests__/diagramGeometry.spec.ts`
- Create: `apps/desktop/src/docs/components/SchemaDiagram.vue`
- Modify: `apps/desktop/src/docs/DocsApp.vue`
- Modify: `apps/desktop/src/docs/__tests__/componentContract.spec.ts`

**Interfaces:**
- Consumes: `layoutDiagramTables(tables: Pick<DiagramTable, "name" | "columns">[], options?: DiagramLayoutOptions): Record<string, DiagramPosition>` from `@/lib/diagram/erDiagram` — permitted by the contract test, which forbids only `@/lib/backend`; that module has exactly one import and it is `import type`, so it bundles cleanly.
- Produces: `export function clipToCard(from: Point, to: Point, half: Size): Point` and `export interface Point { x: number; y: number }`.

Layout is reused. **Edge routing is the genuinely new work** — nothing in the codebase draws a line between two cards.

- [ ] **Step 1: Write the failing geometry test**

Create `apps/desktop/src/docs/__tests__/diagramGeometry.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clipToCard } from "../diagramGeometry";

describe("clipToCard", () => {
  const half = { width: 100, height: 50 };

  it("exits through the vertical edge for a horizontal run", () => {
    // Centre (0,0) to (500,0): the line leaves through the right edge at
    // x = +100, not through the top or bottom.
    expect(clipToCard({ x: 0, y: 0 }, { x: 500, y: 0 }, half)).toEqual({ x: 100, y: 0 });
  });

  it("exits through the horizontal edge for a vertical run", () => {
    expect(clipToCard({ x: 0, y: 0 }, { x: 0, y: 500 }, half)).toEqual({ x: 0, y: 50 });
  });

  it("picks the nearer edge on a diagonal", () => {
    // Slope 1 against a 2:1 card: the vertical edge is reached first, so the
    // result sits ON x = 100 with |y| < 50. Clipping to the wrong axis puts
    // the endpoint outside the card and the line visibly overshoots.
    const point = clipToCard({ x: 0, y: 0 }, { x: 500, y: 500 }, half);
    expect(point.x).toBeCloseTo(50);
    expect(point.y).toBeCloseTo(50);
  });

  it("returns the centre when both points coincide", () => {
    // Two tables laid out at the same position would otherwise divide by zero
    // and emit NaN into the SVG path, which renders nothing at all.
    expect(clipToCard({ x: 7, y: 7 }, { x: 7, y: 7 }, half)).toEqual({ x: 7, y: 7 });
  });

  it("handles negative directions symmetrically", () => {
    expect(clipToCard({ x: 0, y: 0 }, { x: -500, y: 0 }, half)).toEqual({ x: -100, y: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/diagramGeometry.spec.ts`
Expected: FAIL — `Failed to resolve import "../diagramGeometry"`.

- [ ] **Step 3: Implement `diagramGeometry.ts`**

```ts
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Where a line from one card's centre towards another leaves the first card.
 *
 * Without this, edges terminate under the card and appear to sprout from a
 * table's middle. Scaling both axes and taking the smaller factor picks
 * whichever edge the ray actually reaches first.
 *
 * `half` is the card's HALF width and height, measured from its centre.
 */
export function clipToCard(from: Point, to: Point, half: Size): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    // Coincident centres would divide by zero and put NaN in the path data,
    // which renders as nothing rather than as an error.
    return { x: from.x, y: from.y };
  }
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : half.width / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : half.height / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
```

- [ ] **Step 4: Run the geometry test**

Run: `pnpm vitest run apps/desktop/src/docs/__tests__/diagramGeometry.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Create `SchemaDiagram.vue`**

`apps/desktop/src/docs/components/SchemaDiagram.vue` — `<script setup lang="ts">`, props `{ snapshot: SchemaSnapshot; translate: Translate }`, emits `{ select: [tableKey: string] }`.

Compute positions with `layoutDiagramTables(snapshot.tables.map((t) => ({ name: qualifiedTableKey(t), columns: t.columns })))`. Render an `<svg>` sized to the layout extent inside a `<div class="overflow-auto">` — scrolling *is* panning; there are no zoom controls by design.

For each table draw a `<rect>` plus its qualified name and up to eight column names. Apply `groupStyle(hue)` and `style="background-color: var(--group-c)"` for the group accent — never a computed colour, which the contract test bans. For each relationship draw a `<line>` whose endpoints come from `clipToCard` in both directions. A `<rect>` per table carries `@click="emit('select', key)"`.

- [ ] **Step 6: Register it in the contract test and render it in `DocsApp`**

In `componentContract.spec.ts`, add `"SchemaDiagram.vue"` to `EXPECTED` — keep the array alphabetically sorted, since the first test compares against a sorted list.

In `DocsApp.vue`, render `<SchemaDiagram v-else-if="view === 'diagram'" … />` and add a Diagram entry to the sidebar only when `diagram === "inline"`.

- [ ] **Step 7: Run everything and typecheck**

Run: `pnpm vitest run apps/desktop/src/docs && pnpm typecheck`
Expected: PASS, clean. The contract test must confirm `SchemaDiagram.vue` references none of the forbidden needles and computes no colour.

- [ ] **Step 8: Deliberate break**

In `clipToCard`, replace `Math.min(scaleX, scaleY)` with `scaleX`. Run the geometry test; confirm `picks the nearer edge on a diagonal` fails with `expected 100 to be close to 50`. Restore. Report the message.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/docs
git commit -m "$(cat <<'EOF'
feat(docs): add a minimal read-only ER renderer

Reuses layoutDiagramTables from lib/diagram/erDiagram, which is bundleable
as-is: 211 lines with exactly one import, and that import is `import type`.

Edge routing is the new part — nothing in the codebase drew a line between
two cards. clipToCard scales both axes and takes the smaller factor, so an
edge stops on whichever border the ray reaches first instead of vanishing
under the card.

Deliberately minimal: scroll is the pan, there is no zoom, and the host
chooses whether to show this at all. In-app the dialog keeps its button to
the full SchemaDiagramDialog, so no screen offers two ER views.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 5: The export shell and the bundle

**Files:**
- Create: `apps/desktop/src/docs-export/{main.ts,ExportApp.vue,exportTranslate.ts,export.css}`
- Create: `apps/desktop/vite.docs-export.config.ts`
- Create: `apps/desktop/src/docs-export/__tests__/exportTranslate.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseDocsHash`, `formatDocsHash`, `DocsRoute` (Task 3); `DocsApp` with `route`/`diagram` props (Tasks 3–4); `tokens.css` (Task 2).
- Produces: `crates/dbx-core/assets/docs-export.js`, `docs-export.css`, `docs-export.manifest.json`. Tasks 6 and 7 consume all three.
- Produces: the payload contract — `{ snapshot, annotations, lang }` — which Task 6's Rust side must emit exactly.

- [ ] **Step 1: Write the failing translate test**

Create `apps/desktop/src/docs-export/__tests__/exportTranslate.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createExportTranslate, EXPORT_LOCALES } from "../exportTranslate";

describe("createExportTranslate", () => {
  it("carries every locale the app ships", () => {
    expect(Object.keys(EXPORT_LOCALES).sort()).toEqual(["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"]);
  });

  it("resolves a nested key under the docs prefix", () => {
    expect(createExportTranslate("en")("docs.columns")).toBe("Columns");
    expect(createExportTranslate("en")("docs.warnings.orphanedNotes.title")).toBe("Some notes no longer match anything");
  });

  it("substitutes placeholders", () => {
    expect(createExportTranslate("en")("docs.shadowedComment", { comment: "hi" })).toBe("Database comment: hi");
  });

  it("falls back to English for an unknown locale", () => {
    // A hand-edited payload, or a --lang that slipped through, must render
    // English rather than raw keys in a file someone opens offline.
    expect(createExportTranslate("kl" as never)("docs.columns")).toBe("Columns");
  });

  it("returns the key when nothing resolves", () => {
    expect(createExportTranslate("en")("docs.nope.missing")).toBe("docs.nope.missing");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/desktop/src/docs-export`
Expected: FAIL — `Failed to resolve import "../exportTranslate"`.

- [ ] **Step 3: Implement `exportTranslate.ts`**

```ts
import en from "@/i18n/locales/docs/en";
import es from "@/i18n/locales/docs/es";
import it from "@/i18n/locales/docs/it";
import ja from "@/i18n/locales/docs/ja";
import ko from "@/i18n/locales/docs/ko";
import ptBR from "@/i18n/locales/docs/pt-BR";
import zhCN from "@/i18n/locales/docs/zh-CN";
import zhTW from "@/i18n/locales/docs/zh-TW";
import type { Translate } from "@/docs/docsWarnings";

export const EXPORT_LOCALES = { en, es, it, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW } as const;

export type ExportLocale = keyof typeof EXPORT_LOCALES;

function lookup(source: unknown, key: string): string | null {
  const value = key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), source);
  return typeof value === "string" ? value : null;
}

/**
 * Build a `Translate` over a bundled namespace.
 *
 * English is the fallback rather than the raw key. The parity test guarantees
 * all 8 namespaces agree, so this should never fire — it exists so an
 * artefact opened offline degrades to English instead of showing
 * `docs.columns` to a reader. This is not the Part 3b hazard where a fallback
 * masked drift: there the fallback replaced the guard, here the guard runs in
 * CI and this is only a runtime backstop.
 */
export function createExportTranslate(lang: ExportLocale): Translate {
  const primary = EXPORT_LOCALES[lang] ?? EXPORT_LOCALES.en;
  return (key, params) => {
    // Keys arrive prefixed with `docs.` because that is how the namespace is
    // mounted in the app; the bundled modules are the namespace itself.
    const bare = key.startsWith("docs.") ? key.slice("docs.".length) : key;
    const template = lookup(primary, bare) ?? lookup(EXPORT_LOCALES.en, bare);
    if (template === null) return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  };
}
```

- [ ] **Step 4: Run the translate test**

Run: `pnpm vitest run apps/desktop/src/docs-export`
Expected: PASS (5 tests).

- [ ] **Step 5: Write `export.css`**

```css
@import "tailwindcss";
/*
 * Narrowed deliberately. globals.css sources the whole application, and
 * `@source` is additive with no way to un-source, so importing it would emit
 * every utility in DBX rather than the ~40 the viewer uses.
 */
@source "../docs/**/*.vue";
@source "../docs-export/**/*.vue";

@import "../styles/tokens.css";
```

No `@font-face` here — the Vite plugin in Step 6 prepends it with the font already inlined, so no rule can reference a path that fails under `file://`.

- [ ] **Step 6: Write `vite.docs-export.config.ts`**

```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(__dirname, "../..");
const assetsDir = path.join(repoRoot, "crates/dbx-core/assets");
const fontPath = path.join(__dirname, "public/fonts/geist-latin-wght-normal.woff2");

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Inline the font and write the staleness manifest.
 *
 * The manifest is derived from Rollup's ACTUAL module graph, never from a
 * hand-written glob. SchemaDiagram.vue imports erDiagram.ts from outside
 * src/docs/, so a glob of that directory would miss it and the guard would
 * pass while the artefact was stale — the same shape as the three guards
 * this feature has already had to widen after the fact.
 *
 * New files are covered for free: a module can only enter the bundle by being
 * imported, which means editing an existing file, which changes that file's
 * hash. The one hole would be `import.meta.glob`, which the viewer does not
 * use.
 */
function exportBundlePlugin() {
  return {
    name: "dbx-docs-export",
    generateBundle(_options: unknown, bundle: Record<string, { type: string; source?: string | Uint8Array; code?: string; modules?: Record<string, unknown> }>) {
      const font = readFileSync(fontPath).toString("base64");
      const fontFace = `@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url("data:font/woff2;base64,${font}") format("woff2-variations")}\n`;

      const sources: Record<string, string> = {};
      const deps: Record<string, string> = {};
      for (const chunk of Object.values(bundle)) {
        for (const id of Object.keys(chunk.modules ?? {})) {
          if (!path.isAbsolute(id)) continue;
          const nodeModules = id.indexOf("/node_modules/");
          if (nodeModules !== -1) {
            const after = id.slice(nodeModules + "/node_modules/".length);
            const name = after.startsWith("@") ? after.split("/").slice(0, 2).join("/") : after.split("/")[0];
            if (!(name in deps)) {
              const pkg = JSON.parse(readFileSync(path.join(id.slice(0, nodeModules), "node_modules", name, "package.json"), "utf8"));
              deps[name] = pkg.version;
            }
            continue;
          }
          if (!id.startsWith(repoRoot)) continue;
          const relative = path.relative(repoRoot, id);
          sources[relative] = sha256(readFileSync(id));
        }
      }
      sources[path.relative(repoRoot, fontPath)] = sha256(readFileSync(fontPath));

      for (const [name, chunk] of Object.entries(bundle)) {
        if (name.endsWith(".css") && typeof chunk.source === "string") chunk.source = fontFace + chunk.source;
      }

      writeFileSync(
        path.join(assetsDir, "docs-export.manifest.json"),
        `${JSON.stringify({ sources: Object.fromEntries(Object.entries(sources).sort()), deps: Object.fromEntries(Object.entries(deps).sort()) }, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), exportBundlePlugin()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    outDir: assetsDir,
    emptyOutDir: false,
    cssCodeSplit: false,
    // One JS file. Without this the export would need to load chunks over the
    // network, which is precisely what a file:// artefact cannot do.
    rollupOptions: {
      input: path.resolve(__dirname, "src/docs-export/main.ts"),
      output: { inlineDynamicImports: true, entryFileNames: "docs-export.js", assetFileNames: "docs-export.[ext]" },
    },
  },
});
```

- [ ] **Step 7: Write `main.ts` and `ExportApp.vue`**

`main.ts` reads the base64 payload from `<script type="application/dbx-snapshot">`, decodes it, and mounts:

```ts
import { createApp } from "vue";
import ExportApp from "./ExportApp.vue";
import "./export.css";

const node = document.querySelector("script[type='application/dbx-snapshot']");
// `atob` yields one byte per character; the payload is UTF-8, so it must be
// widened before decoding or every non-ASCII table name and note is mangled.
const binary = atob((node?.textContent ?? "").trim());
const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
const payload = JSON.parse(new TextDecoder().decode(bytes));

createApp(ExportApp, { payload }).mount("#app");
```

`ExportApp.vue` holds a `route` ref initialised from `parseDocsHash(location.hash, payload.snapshot, true)`, listens for `hashchange`, writes `location.hash = formatDocsHash(route)` on `update:route`, renders a `<select>` of `EXPORT_LOCALES` bound to a `lang` ref, and renders:

```
<DocsApp :snapshot="payload.snapshot" :annotations="payload.annotations" :readonly="true"
         :translate="translate" :route="route" diagram="inline" @update:route="route = $event" />
```

Language is **not persisted**: under `file://` every document shares one opaque origin, so `localStorage` would leak one export's preference into an unrelated one.

- [ ] **Step 8: Add the build script**

In the root `package.json` `scripts`, after `"build"`:

```json
    "build:docs-export": "vite build --config apps/desktop/vite.docs-export.config.ts",
```

- [ ] **Step 9: Build and inspect**

Run: `pnpm build:docs-export`
Expected: succeeds, writing three files. Verify:

```bash
ls -la crates/dbx-core/assets/docs-export.*
grep -c "url(/" crates/dbx-core/assets/docs-export.css
```
Expected: three files; `0` external URL references.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/docs-export apps/desktop/vite.docs-export.config.ts package.json crates/dbx-core/assets
git commit -m "$(cat <<'EOF'
feat(docs): bundle the viewer as a single-file export

One JS and one CSS, with the font inlined as a data URI, built from the
same components the app renders — which is what the purity contract on
src/docs/ has been protecting since Part 3a.

The staleness manifest is derived from Rollup's module graph rather than a
glob. SchemaDiagram.vue imports erDiagram.ts from outside src/docs/, so a
glob of that directory would miss it and pass while the artefact was stale.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 6: `to_standalone_html`

**Files:**
- Create: `crates/dbx-core/src/docs/export.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Consumes: `crates/dbx-core/assets/docs-export.{js,css}` (Task 5); `SchemaSnapshot` and `AnnotationFile` from `docs::snapshot` / `docs::annotations`.
- Produces: `pub fn to_standalone_html(snapshot: &SchemaSnapshot, annotations: &AnnotationFile, lang: &str) -> Result<String, String>` and `pub const EXPORT_LANGUAGES: [&str; 8]`. Tasks 8 and 9 both call it.

- [ ] **Step 1: Write the failing tests**

Create `crates/dbx-core/src/docs/export.rs` with only its test module, so the tests fail to compile against a missing function:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::annotations::AnnotationFile;
    use crate::docs::snapshot::SchemaSnapshot;

    /// `SchemaSnapshot` is `#[serde(rename_all = "camelCase")]` with
    /// `format_version` at the TOP level — not inside `project` — and
    /// `ProjectMeta` requires `name`, `databaseType`, `schemas` and
    /// `generatedAt`. `AnnotationFile` does NOT derive `Default`, and its
    /// `format_version` must be 1, so it is built explicitly.
    fn fixture() -> (SchemaSnapshot, AnnotationFile) {
        let snapshot: SchemaSnapshot = serde_json::from_str(
            r#"{"formatVersion":1,"project":{"name":"shop","databaseType":"postgres","database":"shop","schemas":["public"],"generatedAt":"2026-08-06T00:00:00Z","note":null},"tables":[],"enums":[],"relationships":[],"groups":[],"warnings":[]}"#,
        )
        .expect("fixture snapshot");
        let annotations = AnnotationFile {
            format_version: 1,
            project: None,
            groups: Vec::new(),
            tables: std::collections::BTreeMap::new(),
        };
        (snapshot, annotations)
    }

    #[test]
    fn a_note_containing_a_closing_script_tag_survives() {
        // THE reason the payload is base64. A note discussing HTML is
        // entirely plausible in a schema document, and inlined as text it
        // would terminate the script element early and inject the rest of
        // the payload as markup.
        let (snapshot, mut annotations) = fixture();
        annotations.project = Some(crate::docs::annotations::ProjectAnnotation {
            name: None,
            note: Some("</script><img src=x onerror=alert(1)>".into()),
        });
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");

        assert!(!html.contains("<img src=x"), "the payload leaked into markup");
        assert_eq!(html.matches("</script>").count(), 2, "exactly the two real script elements");
    }

    #[test]
    fn the_payload_round_trips() {
        let (snapshot, annotations) = fixture();
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");
        let start = html.find("application/dbx-snapshot").expect("payload element");
        let body = &html[start..];
        let encoded = body[body.find('>').unwrap() + 1..body.find("</script>").unwrap()].trim();
        let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).expect("valid base64");
        let value: serde_json::Value = serde_json::from_slice(&decoded).expect("valid json");
        assert_eq!(value["snapshot"]["project"]["name"], "shop");
        assert_eq!(value["lang"], "en");
    }

    #[test]
    fn nothing_is_loaded_from_the_network() {
        // The whole point of the artefact. A single absolute URL left in the
        // CSS means the file renders unstyled on a machine with no network,
        // and nothing else would catch it.
        let (snapshot, annotations) = fixture();
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");
        for needle in ["http://", "https://", "url(/", "src=\"/", "href=\"/"] {
            assert!(!html.contains(needle), "export references {needle}");
        }
    }

    #[test]
    fn an_unknown_language_is_rejected() {
        let (snapshot, annotations) = fixture();
        let error = to_standalone_html(&snapshot, &annotations, "kl").expect_err("should reject");
        assert!(error.contains("kl"), "got: {error}");
        assert!(error.contains("en"), "the error must list the valid locales, got: {error}");
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test -p dbx-core --lib docs::export`
Expected: FAIL to compile — `cannot find function to_standalone_html in this scope`.

- [ ] **Step 3: Implement `to_standalone_html`**

Above the test module in the same file:

```rust
use base64::Engine as _;

use crate::docs::annotations::AnnotationFile;
use crate::docs::snapshot::SchemaSnapshot;

/// The viewer bundle, built by `pnpm build:docs-export` and committed.
///
/// Committed rather than built by cargo because Rust cannot run Vite and
/// `dbx docs` must work from a plain `cargo install` on a machine with no
/// Node. `docs_export_bundle_is_current` is what keeps it honest.
const EXPORT_JS: &str = include_str!("../../assets/docs-export.js");
const EXPORT_CSS: &str = include_str!("../../assets/docs-export.css");

pub const EXPORT_LANGUAGES: [&str; 8] = ["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"];

/// Render a snapshot as one self-contained HTML file.
///
/// `snapshot` must already have annotations applied — `apply_annotations` is
/// Rust and the export has no Rust at runtime. `annotations` travels too,
/// because the merge erases what the viewer needs to colour groups:
/// `snapshot.groups` holds resolved `TableGroup`s, `annotations.groups` holds
/// the hue.
pub fn to_standalone_html(snapshot: &SchemaSnapshot, annotations: &AnnotationFile, lang: &str) -> Result<String, String> {
    if !EXPORT_LANGUAGES.contains(&lang) {
        return Err(format!("Unknown language \"{lang}\". Valid values: {}.", EXPORT_LANGUAGES.join(", ")));
    }

    let payload = serde_json::json!({ "snapshot": snapshot, "annotations": annotations, "lang": lang });
    let json = serde_json::to_vec(&payload).map_err(|error| format!("Failed to serialise the documentation payload: {error}"))?;
    // base64 rather than escaped JSON: the alphabet cannot contain `<`, so no
    // escaping rule exists to forget. The alternative's correctness depends
    // on every serialisation path applying the escape.
    let encoded = base64::engine::general_purpose::STANDARD.encode(&json);

    let title = html_escape(&snapshot.project.name);
    Ok(format!(
        "<!doctype html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{title}</title>\n<style>{EXPORT_CSS}</style>\n</head>\n<body>\n<div id=\"app\"></div>\n<script type=\"application/dbx-snapshot\">{encoded}</script>\n<script>{EXPORT_JS}</script>\n</body>\n</html>\n"
    ))
}

fn html_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
```

Add to `crates/dbx-core/src/docs/mod.rs`:

```rust
pub mod export;
```
and to the re-export list:
```rust
pub use export::{to_standalone_html, EXPORT_LANGUAGES};
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core --lib docs::export`
Expected: PASS (4 tests).

- [ ] **Step 5: Deliberate break**

Replace the base64 encode with `String::from_utf8(json).unwrap()`. Run the tests; confirm `a_note_containing_a_closing_script_tag_survives` fails with `the payload leaked into markup`. Restore. Report the message.

- [ ] **Step 6: Commit**

```bash
git add crates/dbx-core/src/docs
git commit -m "$(cat <<'EOF'
feat(docs): render a snapshot as one self-contained HTML file

The payload is base64 rather than escaped JSON. A note containing the
literal `</script>` — plausible in any schema document that discusses HTML —
would otherwise terminate the script element early and inject the remainder
as markup. base64's alphabet cannot contain `<`, so the property holds by
construction rather than by remembering to escape on every path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 7: The staleness guard

**Files:**
- Modify: `crates/dbx-core/src/docs/export.rs`

**Interfaces:**
- Consumes: `crates/dbx-core/assets/docs-export.manifest.json` (Task 5).

- [ ] **Step 1: Write the test**

Append to the `tests` module in `export.rs`:

```rust
    /// The committed bundle must match the sources it was built from.
    ///
    /// Skips only when the crate is consumed from a published package, where
    /// `apps/desktop/` does not exist. That skip is itself a hazard — a
    /// vacuous skip in CI would silently disable this guard — so it keys off
    /// a repository-only marker rather than off the absence of the sources.
    #[test]
    fn docs_export_bundle_is_current() {
        use sha2::{Digest, Sha256};

        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("workspace root");
        if !workspace.join("pnpm-workspace.yaml").exists() {
            return; // packaged crate: the sources are genuinely absent
        }

        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../assets/docs-export.manifest.json")).expect("manifest is valid JSON");
        let sources = manifest["sources"].as_object().expect("manifest.sources");
        assert!(sources.len() > 5, "manifest lists only {} sources — the build emitted an empty graph", sources.len());

        let mut stale = Vec::new();
        for (relative, expected) in sources {
            let path = workspace.join(relative);
            let Ok(bytes) = std::fs::read(&path) else {
                stale.push(format!("{relative} (missing)"));
                continue;
            };
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if actual != expected.as_str().unwrap_or_default() {
                stale.push(relative.clone());
            }
        }

        assert!(stale.is_empty(), "the committed docs export bundle is stale.\nChanged: {}\nRun: pnpm build:docs-export", stale.join(", "));
    }
```

- [ ] **Step 2: Run it**

Run: `cargo test -p dbx-core --lib docs::export::tests::docs_export_bundle_is_current`
Expected: PASS — the bundle was built in Task 5 and nothing has changed since.

- [ ] **Step 3: Deliberate break**

Append a blank line to `apps/desktop/src/docs/DocsApp.vue`. Run the test. Confirm it fails with `the committed docs export bundle is stale. Changed: apps/desktop/src/docs/DocsApp.vue`. Revert the edit and re-run to confirm it passes. Report the message.

- [ ] **Step 4: Verify the guard reaches outside `src/docs/`**

This is the whole reason the manifest is derived rather than globbed. Append a blank line to `apps/desktop/src/lib/diagram/erDiagram.ts` — a file a `src/docs/**` glob would have missed entirely. Run the test; confirm it fails naming that file. Revert. Report the message.

- [ ] **Step 5: Commit**

```bash
git add crates/dbx-core/src/docs/export.rs
git commit -m "$(cat <<'EOF'
test(docs): fail when the committed export bundle is stale

Verified to bite on a change to erDiagram.ts, which lives outside src/docs/
and which a directory glob would have missed — the failure mode this guard
exists to prevent.

The packaged-crate skip keys off pnpm-workspace.yaml rather than off the
absence of the sources, so a CI checkout cannot silently skip it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 8: The `dbx docs` verb

**Files:**
- Modify: `crates/dbx-cli/src/main.rs`

**Interfaces:**
- Consumes: `dbx_core::docs::to_standalone_html` and `EXPORT_LANGUAGES` (Task 6).

`run_docs` mirrors `run_dbml` (line 461) exactly, with one difference: `run_dbml` scopes `annotations` inside its `if let`, but the export needs the `AnnotationFile` **after** applying it, so it must be hoisted.

- [ ] **Step 1: Write the failing flag tests**

Add beside the existing `dbml` flag tests (around line 1148):

```rust
    #[test]
    fn parses_the_lang_flag() {
        let flags = parse_flags(&args(&["docs", "local", "--lang", "zh-CN"])).expect("parse");
        assert_eq!(flags.args, args(&["docs", "local"]));
        assert_eq!(flags.lang.as_deref(), Some("zh-CN"));
    }

    #[test]
    fn lang_requires_a_value() {
        parse_flags(&args(&["docs", "local", "--lang"])).expect_err("should fail");
    }

    #[test]
    fn docs_appears_in_the_usage_text() {
        assert!(usage().contains("dbx docs <connection>"), "got: {}", usage());
    }
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p dbx-cli parses_the_lang_flag`
Expected: FAIL to compile — `no field 'lang' on type 'Flags'`.

- [ ] **Step 3: Add the flag**

Add `lang: Option<String>,` to `struct Flags`, and beside the `"--notes"` arm (line 573):

```rust
            "--lang" => flags.lang = Some(option_value(argv, &mut index, "--lang")?),
```

- [ ] **Step 4: Add the verb**

Beside the `dbml` dispatch (line 245):

```rust
    if args.first().is_some_and(|arg| arg == "docs") {
        return run_docs(backend, &flags).await;
    }
```

And the function, mirroring `run_dbml`:

```rust
async fn run_docs(backend: &dyn DbxBackend, flags: &Flags) -> Result<String, CliError> {
    let args = &flags.args;
    let connection_name = required(args.get(1), "Connection name is required.")?;
    let connection = find_connection(backend, connection_name).await?;
    let database = selected_database(&connection, flags.database.as_deref());

    let options = DocsSnapshotOptions {
        schemas: flags.schema.clone().into_iter().collect(),
        tables: flags.tables.clone(),
        project_name: Some(connection.name.clone()),
    };

    let mut snapshot = backend.collect_docs_snapshot(&connection, &database, options).await.map_err(command_error)?;

    // Unlike run_dbml, the AnnotationFile is needed AFTER it has been applied:
    // the merge resolves groups into TableGroups and drops the hue the viewer
    // colours with, so the raw file has to travel too.
    //
    // AnnotationFile does not derive Default and `format_version` must be 1,
    // so the empty value is constructed explicitly rather than defaulted.
    let mut annotations = dbx_core::docs::annotations::AnnotationFile {
        format_version: 1,
        project: None,
        groups: Vec::new(),
        tables: std::collections::BTreeMap::new(),
    };
    if let Some(path) = flags.notes.as_ref() {
        require_notes_file(path)?;
        if let Some(loaded) = dbx_core::docs::annotations::load_annotations(path)
            .map_err(|error| CliError::new("NOTES_INVALID", error))?
        {
            dbx_core::docs::annotations::apply_annotations(&mut snapshot, &loaded, connection.db_type);
            annotations = loaded;
        }
    }

    for warning in &snapshot.warnings {
        eprintln!("warning: {warning}");
    }

    let lang = flags.lang.as_deref().unwrap_or("en");
    let html = dbx_core::docs::to_standalone_html(&snapshot, &annotations, lang).map_err(|error| CliError::new("EXPORT_FAILED", error))?;

    match flags.out.as_ref() {
        Some(path) => {
            std::fs::write(path, &html)
                .map_err(|error| CliError::new("WRITE_FAILED", format!("Failed to write {}: {error}", path.display())))?;
            Ok(format!("Wrote {} bytes to {}", html.len(), path.display()))
        }
        None => Ok(html),
    }
}
```

- [ ] **Step 5: Add the usage line**

In `usage()`, after the `dbx dbml` line:

```
\n  dbx docs <connection> [--out path] [--notes path] [--lang code] [--schema name] [--database name] [--tables a,b]
```

- [ ] **Step 6: Run the tests and try it**

Run: `cargo test -p dbx-cli`
Expected: PASS.

Run against a live connection:
```bash
cargo run -p dbx-cli -- docs <connection> --database <db> --schema public --out /tmp/schema.html
```
Expected: `Wrote N bytes to /tmp/schema.html`. Then open it in a browser over `file://` and confirm the index renders, a table page opens, the hash updates, a reload keeps the page, and the language switcher works.

- [ ] **Step 7: Commit**

```bash
git add crates/dbx-cli/src/main.rs
git commit -m "$(cat <<'EOF'
feat(cli): add the dbx docs verb

Mirrors dbx dbml's flags and collector, plus --lang. An unknown language
fails with the list of valid values rather than falling back — the same
reasoning that made --notes explicit in Part 2.

Unlike run_dbml, the AnnotationFile is kept after being applied: the merge
resolves groups into TableGroups and drops the hue the viewer colours with.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 9: The in-app export button

**Files:**
- Modify: `src-tauri/src/commands/docs.rs`, `src-tauri/src/lib.rs`
- Modify: `crates/dbx-web/src/routes/docs.rs`, `crates/dbx-web/src/main.rs`
- Modify: `apps/desktop/src/lib/backend/{api,tauri,http}.ts`
- Modify: `apps/desktop/src/components/docs/DatabaseDocsDialog.vue`

**Interfaces:**
- Consumes: `to_standalone_html` (Task 6); the `docs.exportHtml` / `docs.exporting` / `docs.exportFailed` keys (Task 1).
- Produces: `exportDocsHtml(filePath: string, snapshot: SchemaSnapshot, annotations: AnnotationFile, lang: string): Promise<void>` on both transports.

**Rust writes the file; the frontend supplies the path.** This mirrors `exportQueryResultCsv(filePath, columns, rows)` at `apps/desktop/src/lib/backend/tauri.ts:3807`, and avoids returning a ~400 KB string across IPC only to write it back out.

**Every backend operation exists twice** — once in `tauri.ts`, once in `http.ts`. `api.ts` types the backend as `typeof TauriModule` and resolves either at runtime, so a signature that differs between them compiles on both sides and fails only when a user clicks the button. Add both.

- [ ] **Step 1: Add the Tauri command**

In `src-tauri/src/commands/docs.rs`, following the shape at line 34:

```rust
#[tauri::command]
pub async fn docs_export_html(
    file_path: String,
    snapshot: SchemaSnapshot,
    annotations: AnnotationFile,
    lang: String,
) -> Result<(), String> {
    let html = dbx_core::docs::to_standalone_html(&snapshot, &annotations, &lang)?;
    std::fs::write(&file_path, html).map_err(|error| format!("Failed to write {file_path}: {error}"))
}
```

Tauri converts argument names between camelCase and snake_case **by name**: the frontend sends `filePath` and this receives `file_path`. A mismatch compiles cleanly on both sides and fails only at runtime, so keep the names aligned.

Register it in `src-tauri/src/lib.rs` beside the other four (lines 1742–1745): `commands::docs::docs_export_html,`.

- [ ] **Step 2: Add the web route**

In `crates/dbx-web/src/routes/docs.rs` add a handler with a `#[serde(rename_all = "camelCase")]` request struct carrying `snapshot`, `annotations`, `lang`, returning the HTML string. Register it in `crates/dbx-web/src/main.rs` beside the existing docs routes (around line 377):

```rust
        .route("/docs/export", post(routes::docs::export_html))
```

- [ ] **Step 3: Add both transports**

`apps/desktop/src/lib/backend/tauri.ts`, beside `collectDocsSnapshot` (line 1626):

```ts
export async function exportDocsHtml(filePath: string, snapshot: SchemaSnapshot, annotations: AnnotationFile, lang: string): Promise<void> {
  return invoke("docs_export_html", { filePath, snapshot, annotations, lang });
}
```

`http.ts` gets the same signature posting to `/docs/export`. `api.ts`, after line 185:

```ts
export const exportDocsHtml = forward("exportDocsHtml");
```

- [ ] **Step 4: Add the button**

In `DatabaseDocsDialog.vue`, beside the existing diagram button (line ~182), add an Export button. Follow the established export pattern from `apps/desktop/src/composables/useDataGridExport.ts:649-662` — a default filename, replaced by a real path from the Tauri save dialog when running in Tauri, then one call that is identical in both runtimes:

```ts
async function exportHtml(): Promise<void> {
  if (!snapshot.value) return;
  exporting.value = true;
  exportError.value = null;
  try {
    let outputPath = `${snapshot.value.project.name}-docs.html`;
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ defaultPath: outputPath, filters: [{ name: "HTML", extensions: ["html"] }] });
      if (!chosen) return; // the user cancelled; not an error
      outputPath = chosen as string;
    }
    await api.exportDocsHtml(outputPath, snapshot.value, annotations.value, locale.value);
  } catch (error) {
    // Never swallowed: a failed export that reports success is the worst
    // outcome here, exactly as with a failed autosave.
    exportError.value = translate("docs.exportFailed", { error: String(error) });
  } finally {
    exporting.value = false;
  }
}
```

`locale.value` comes from `useI18n()`, which this component already imports — it lives outside `src/docs/` and so is permitted to. If the app's locale is not one of the eight, `to_standalone_html` rejects it; map it to `"en"` before calling rather than surfacing that error.

Show `docs.exporting` on the button while in flight and `docs.exportFailed` on failure.

- [ ] **Step 5: Verify**

Run: `cargo check --workspace && pnpm typecheck`
Expected: clean.

Then run the app (`pnpm dev:web` with `DBX_DISABLE_PASSWORD=1` plus the backend) and click Export. Confirm the saved file opens over `file://` and is **byte-identical** to the CLI's output for the same inputs:

```bash
cmp /tmp/from-cli.html /tmp/from-app.html && echo "identical"
```
Expected: `identical`. They call the same function; any difference means one caller is passing something the other is not.

- [ ] **Step 6: Commit**

```bash
git add src-tauri crates/dbx-web apps/desktop/src
git commit -m "$(cat <<'EOF'
feat(docs): export documentation as HTML from the app

The button and `dbx docs` call the same Rust function, so the two cannot
drift — verified by comparing their output byte-for-byte.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Task 10: Prove the exported file actually runs

Every test so far checks that the artefact *looks* right. None executes it. This task attempts the one that does.

**Files:**
- Create: `apps/desktop/src/docs-export/__tests__/exportSmoke.spec.ts`

- [ ] **Step 1: Attempt the happy-dom smoke test**

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// @vitest-environment happy-dom

const htmlPath = path.resolve(__dirname, "../../../../../target/docs-export-smoke.html");

describe("the exported file", () => {
  beforeAll(() => {
    // Generated by a small Rust example so the test exercises the REAL
    // to_standalone_html output rather than a hand-built approximation.
    execFileSync("cargo", ["run", "-p", "dbx-core", "--example", "docs_export_smoke", "--", htmlPath], { stdio: "inherit" });
  });

  it("mounts and renders a table name", async () => {
    document.documentElement.innerHTML = readFileSync(htmlPath, "utf8");
    for (const script of Array.from(document.querySelectorAll("script"))) {
      if (script.getAttribute("type") === null) new Function(script.textContent ?? "")();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector("#app")?.textContent ?? "").toContain("public.orders");
  });
});
```

This needs a `crates/dbx-core/examples/docs_export_smoke.rs` that builds a two-table snapshot, calls `to_standalone_html`, and writes it to `argv[1]`.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run apps/desktop/src/docs-export/__tests__/exportSmoke.spec.ts`

- [ ] **Step 3: Decide honestly**

If it passes, keep it — it is the most valuable test in this part.

**If happy-dom cannot execute the Vue bundle, delete the test rather than weakening it into something that passes without proving anything.** Record in the task report exactly what failed and with what message, and note that the artefact is instead covered by `nothing_is_loaded_from_the_network` plus manual `file://` verification. A test that mounts nothing but asserts `true` is worse than no test, because it reads as coverage.

- [ ] **Step 4: Manual verification either way**

Open the generated file in a real browser over `file://` with the network disabled. Confirm: the index renders with the correct font; a table page opens; the hash updates; a reload lands on the same page; a deep link to a removed table falls back to the index; the language switcher changes the chrome; the diagram renders and clicking a table navigates.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/docs-export crates/dbx-core/examples
git commit -m "$(cat <<'EOF'
test(docs): execute the exported file rather than only inspecting it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ro4mfGEmsbbH32WYsvxsfH
EOF
)"
```

---

## Final verification

- [ ] `make check` — format, lint, typecheck, tests
- [ ] `make cargo-check-fast`
- [ ] `cargo test -p dbx-core --lib docs`
- [ ] `pnpm vitest run apps/desktop/src/docs apps/desktop/src/docs-export apps/desktop/src/i18n`
- [ ] `pnpm build:docs-export && git diff --exit-code crates/dbx-core/assets/` — confirms the committed bundle is what the current sources produce
- [ ] Update PR #5559's body with the export screenshots and the `dbx docs` usage

Note: `queryStore.test.ts > result cache eviction keeps recently accessed inactive tabs` is a known wall-clock-timeout flake under full-suite load. It passes in isolation and on re-run, and is untouched by this work. Re-run before investigating.
