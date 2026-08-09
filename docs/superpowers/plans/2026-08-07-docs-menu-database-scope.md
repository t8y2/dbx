# Documentation Menu at Database Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "Documentation" context-menu entry out of the object browser's table and view menus and into the sidebar's database and schema context menu, so the entry sits at the scope it actually documents.

**Architecture:** A new `openDocs` action in `useSidebarTreeToolRuntime` writes `connectionStore.docsSource` from the active tree node, exactly as the neighbouring `openDiagram` does. One `items.push` in `buildDatabaseSidebarMenu` exposes it on database and schema nodes. The two `ObjectBrowser.vue` entries and their helper are deleted. No backend, dialog, or viewer code changes.

**Tech Stack:** Vue 3 SFC with `<script setup>`, TypeScript, Pinia (`connectionStore`), vue-i18n, `@lucide/vue` icons, Vitest.

## Global Constraints

- Branch is `fix/docs-menu-database-scope`, cut from `upstream/main` at `29fe57143`. Work on it directly; do not create a worktree.
- Do not modify `VERSION`, `package.json`, or any file under `crates/`. Version numbers belong to upstream's `scripts/release.mjs`.
- Do not add an i18n key. `docs.title` already resolves to "Documentation" in all eight locales, added by PR #5559.
- Icons come from `@lucide/vue`, not `lucide-vue-next`.
- Do not touch either `t("diagram.open")` menu entry.
- Reuse the existing `canOpenDiagram` computed as the visibility gate. Do not add a `docs` key to `DATABASE_PRODUCT_CAPABILITY_KEYS`; that is deliberately out of scope and flagged as a follow-up in the PR description.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts` | Sidebar actions that open a tool dialog by writing a `*Source` field on `connectionStore`. | Add `openDocs`; export it. |
| `apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts` | Behavioural cover for `openDocs`. | Create. |
| `apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue` | Builds every sidebar context menu. | Import `BookOpen`, destructure `openDocs`, push one menu item in `buildDatabaseSidebarMenu`. |
| `apps/desktop/src/components/objects/ObjectBrowser.vue` | Object list panel and its per-object context menus. | Delete the docs entries, the `openDocs` helper, and the orphaned `BookOpen` import. |
| `apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts` | Guards the placement so the entry cannot drift back onto table menus. | Create. |

---

## Task 1: Sidebar `openDocs` action

**Files:**
- Modify: `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts:55-64` (insert after `openDiagram`), and the return block at `:132-145`
- Test: `apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts` (create)

**Interfaces:**
- Consumes: `options.activeNode: ShallowRef<TreeNode>` and `options.connectionStore`, both already destructured at the top of `useSidebarTreeToolRuntime`.
- Produces: `openDocs(): void`, returned from `useSidebarTreeToolRuntime`. It sets `connectionStore.docsSource` to `{ connectionId: string; database: string; schema: string | undefined }`. Task 2 binds this to a menu item.

**Why `schema` is passed through untouched:** `DatabaseDocsDialog.vue:93` reads `props.prefillSchema ? [props.prefillSchema] : []`. An `undefined` schema therefore sends an empty schema list, which the collector treats as "everything it finds" — the whole database. A database tree node has no `schema`, a schema node does, so forwarding the field verbatim gives both scopes for free.

**Why no `tableName`:** `openDiagram` passes one because the diagram dialog has a `tableName` prop. `DatabaseDocsDialog` has only `prefillConnectionId`, `prefillDatabase`, and `prefillSchema`. Passing `tableName` would be dead data.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts`.

The composable imports only types plus two pure helpers from `@/lib/sidebar/sidebarExportRuntime`, so no `vi.mock` is needed. `queryStore`, `settingsStore`, and `tableChildObjectName` are unused by `openDocs`; they are passed as minimal stubs because the options object requires them.

```ts
import { shallowRef } from "vue";
import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";

import { useSidebarTreeToolRuntime } from "@/composables/useSidebarTreeToolRuntime";

function setup(node: Partial<TreeNode>) {
  const activeNode = shallowRef({ id: "n-1", label: "node", children: [], ...node } as TreeNode);
  const connectionStore = { docsSource: null as unknown };
  const runtime = useSidebarTreeToolRuntime({
    activeNode,
    connectionStore: connectionStore as never,
    queryStore: {} as never,
    settingsStore: {} as never,
    tableChildObjectName: () => "",
  });
  return { connectionStore, runtime };
}

describe("useSidebarTreeToolRuntime openDocs", () => {
  it("documents the whole database when invoked on a database node", () => {
    const { connectionStore, runtime } = setup({ type: "database", label: "shop", connectionId: "conn-1", database: "shop" });

    runtime.openDocs();

    // An absent schema is what makes the collector document every schema.
    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: undefined });
  });

  it("narrows to a single schema when invoked on a schema node", () => {
    const { connectionStore, runtime } = setup({ type: "schema", label: "public", connectionId: "conn-1", database: "shop", schema: "public" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: "public" });
  });

  it("does nothing when the node carries no database", () => {
    const { connectionStore, runtime } = setup({ type: "connection", label: "local", connectionId: "conn-1" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts`

Expected: FAIL. All three cases error with `runtime.openDocs is not a function`.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts`, insert immediately after the closing brace of `openDiagram` (currently line 64):

```ts
  function openDocs() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    connectionStore.docsSource = {
      connectionId: node.connectionId,
      database: node.database,
      // A database node has no schema, and an absent schema is what tells the
      // collector to document every schema in the database.
      schema: node.schema,
    };
  }
```

Then add `openDocs,` to the returned object, keeping the existing alphabetical order — between `openDiagram,` and `openFieldLineage,`:

```ts
  return {
    openAllDatabasesExport,
    openDataCompare,
    openDatabaseExport,
    openDatabaseSearch,
    openDiagram,
    openDocs,
    openFieldLineage,
    openScheduledBackups,
    openSchemaDiff,
    openSqlFileExecution,
    openStructureEditor,
    openTableImport,
    openTransfer,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useSidebarTreeToolRuntime.ts apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts
git commit -m "feat(docs): add a sidebar action opening documentation for a node"
```

---

## Task 2: Move the menu entry

**Files:**
- Modify: `apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue:13` (icon import), `:312` (destructure), `:4204-4206` (menu push)
- Modify: `apps/desktop/src/components/objects/ObjectBrowser.vue:9` (icon import), `:1466-1474` (helper), `:2666-2671` and `:2721-2726` (menu entries)
- Test: `apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts` (create)

**Interfaces:**
- Consumes: `openDocs()` from Task 1, reached through the existing `useSidebarTreeToolRuntime(...)` destructure at `SidebarTreeRuntimeHost.vue:312`.
- Produces: no new exports.

**Why the single push covers both node types:** line 4204 sits inside `buildDatabaseSidebarMenu` (lines 4147-4259), whose outer guard is `node.type === "database" || node.type === "schema"`. The other `t("diagram.open")` push, at line 4483, is in `buildObjectSidebarMenu` and must be left alone.

**On the placement test:** this repository contains both mounted component specs and source-text specs. A mounted test is impractical for a 4700-line SFC whose menus are assembled from dozens of store-backed computeds, and the behaviour that matters — what `openDocs` writes — is already covered by Task 1. The spec below is a deliberately narrow placement guard: it asserts which file registers `docs.title`, nothing about rendering. Do not extend it into a substitute for behavioural cover.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("documentation menu placement", () => {
  it("registers the entry in the sidebar database menu", () => {
    // The docs viewer documents a database or a schema, so it belongs on the
    // tree nodes that name one.
    expect(source("../../sidebar/SidebarTreeRuntimeHost.vue")).toContain('t("docs.title"), action: openDocs');
  });

  it("keeps the entry off per-object menus", () => {
    // openDocs never read the row's table: a table-level entry advertised a
    // scope the viewer cannot render.
    expect(source("../ObjectBrowser.vue")).not.toContain("docs.title");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts`

Expected: FAIL, both cases. The first fails because `SidebarTreeRuntimeHost.vue` has no `docs.title`; the second fails because `ObjectBrowser.vue` still has two.

- [ ] **Step 3: Register the entry in the sidebar**

In `apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue`:

Add `BookOpen,` as the first name in the `@lucide/vue` import block, immediately after `import {` on line 13. The block is not alphabetically ordered, so position is a matter of readability only:

```ts
import {
  BookOpen,
  Database,
  ChevronsDown,
```

Add `openDocs` to the destructure on line 312, keeping alphabetical order:

```ts
const { openAllDatabasesExport, openDataCompare, openDatabaseExport, openDatabaseSearch, openDiagram, openDocs, openFieldLineage, openScheduledBackups, openSchemaDiff, openSqlFileExecution, openStructureEditor, openTableImport, openTransfer } = useSidebarTreeToolRuntime({
```

Replace lines 4204-4206:

```ts
    if (canOpenDiagram.value) {
      items.push({ label: t("diagram.open"), action: openDiagram, icon: Network });
      items.push({ label: t("docs.title"), action: openDocs, icon: BookOpen });
    }
```

- [ ] **Step 4: Remove the object browser entries**

In `apps/desktop/src/components/objects/ObjectBrowser.vue`:

Delete `BookOpen,` from the icon import on line 9. It has no other use in the file.

Delete the `openDocs` helper, lines 1466-1474 inclusive, together with the blank line that followed it:

```ts
function openDocs(row: ObjectBrowserRow) {
  // The docs viewer documents the whole schema rather than one object, so the
  // row only supplies which schema to collect.
  connectionStore.docsSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
  };
}
```

In `getTableMenuItems`, collapse lines 2666-2671 back to the single-entry form:

```ts
    ...(canOpenDiagram.value ? [{ label: t("diagram.open"), action: () => openDiagram(item), icon: Network }] : []),
```

In `getViewMenuItems`, collapse lines 2721-2726 to exactly the same single line.

- [ ] **Step 5: Run the placement test to verify it passes**

Run: `npx vitest run apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts`

Expected: PASS, 2 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

Expected: no errors. This is what catches a stale `BookOpen` reference or a mistyped `openDocs` in the destructure. An unused-import error here means step 4 removed a menu entry but left the icon, or the reverse.

- [ ] **Step 7: Run the surrounding suites**

Run: `npx vitest run apps/desktop/src/composables apps/desktop/src/components/objects apps/desktop/src/components/sidebar`

Expected: PASS. No existing spec asserts on the docs menu entries, so nothing should need updating. If a sidebar spec fails on menu-item counts or ordering, that spec is the source of truth for the menu's shape — read it before changing it.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue apps/desktop/src/components/objects/ObjectBrowser.vue apps/desktop/src/components/objects/__tests__/docsMenuPlacement.spec.ts
git commit -m "fix(docs): move Documentation to the database context menu"
```

---

## Manual verification

Automated cover stops at "the right store field gets the right value". Confirm the dialog end of the wire once, by hand:

```bash
pnpm dev
```

1. Right-click a PostgreSQL database node in the connections sidebar. "Documentation" appears directly below "View Diagram", with a book icon.
2. Click it. The viewer opens listing tables from **every** schema in that database, not just `public`.
3. Close it, right-click a schema node, pick "Documentation". Only that schema's tables are listed.
4. Open the object browser for the same database and right-click a table. There is no "Documentation" entry; "View Diagram" is still there.
5. Right-click a Redis or MongoDB connection's database node. No "Documentation" entry, because `supportsSchemaDiagram` is false for those drivers — the same visibility set that shipped in v0.5.77.

## Pull request

Target `t8y2/dbx`, base `main`. The description should state that PR #5559's entry point never used the row's table (`ObjectBrowser.vue:1466` read only `row.schema`), so this is a placement correction rather than a feature change, and should flag the follow-up the spec records: documentation visibility currently rides on `supportsSchemaDiagram`, and a dedicated `docs` capability key in `database-drivers.manifest.json` is worth considering separately.
