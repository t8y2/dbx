# Documentation Menu at Database Scope Design

**Date:** 2026-08-07

## Goal

Move the "Documentation" context-menu entry from the object browser's table and
view menus to the sidebar's database and schema context menu, so the entry
appears at the scope it actually documents.

## Background

PR #5559 ("feat(docs): database documentation viewer and DBML export") shipped in
v0.5.77. It added the only entry point for the docs viewer to
`ObjectBrowser.vue`, in the table menu and the view menu, nested inside the
existing `canOpenDiagram` branch alongside "View Diagram".

That placement misrepresents what the action does. `openDocs(row)` in
`ObjectBrowser.vue:1466` reads only `row.schema`; the row's table is discarded.
`DatabaseDocsDialog.vue` accepts `prefillConnectionId`, `prefillDatabase`, and
`prefillSchema` — there is no table prop, so the viewer cannot deep-link to a
table even in principle. A user who right-clicks `orders` and picks
"Documentation" gets documentation for the whole schema.

The docs collector was designed for the wider scope. `DatabaseDocsDialog.vue:91`
carries the comment "An absent schema means 'everything the collector finds'",
and `connectionStore.docsSource.schema` is already optional. Database-scoped
documentation is the case the backend was built for and is currently
unreachable from the UI.

Users therefore look for the entry on the database node in the connections
sidebar, where "View Diagram" already sits, and do not find it.

## Requirements

- offer "Documentation" on sidebar database nodes, documenting the whole database
- offer "Documentation" on sidebar schema nodes, documenting that schema only
- remove the entry from the object browser's table and view menus
- keep the set of drivers that expose the entry identical to v0.5.77
- change no backend, dialog, or viewer code
- leave the "View Diagram" entries in both menus untouched

## Non-Goals

- deep-linking the viewer to a single table (would need a new dialog prop and a
  viewer route change; a separate change if it is ever wanted)
- introducing a `docs` driver capability key (see Gating below)
- any change to `crates/dbx-core`

## Design

### Sidebar action

`useSidebarTreeToolRuntime.ts` gains `openDocs`, mirroring `openDiagram` at
line 55:

```ts
function openDocs() {
  const node = activeNode.value;
  if (!node.connectionId || !node.database) return;
  connectionStore.docsSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
  };
}
```

`node.schema` carries the whole behaviour. It is `undefined` on a database node,
so `DatabaseDocsDialog.vue:93` (`props.prefillSchema ? [props.prefillSchema] : []`)
sends an empty schema list and the collector documents the entire database. On a
schema node it is set, and the collector is limited to that schema.

`openDiagram` also passes `tableName`; `openDocs` does not. The docs dialog has
no corresponding prop, so passing it would be dead data.

### Menu registration

One `items.push` in `SidebarTreeRuntimeHost.vue`, immediately after the
"View Diagram" push at line 4205:

```ts
if (canOpenDiagram.value) {
  items.push({ label: t("diagram.open"), action: openDiagram, icon: Network });
  items.push({ label: t("docs.title"), action: openDocs, icon: BookOpen });
}
```

Line 4205 sits inside `buildDatabaseSidebarMenu` (lines 4147-4259), whose guard
is `node.type === "database" || node.type === "schema"`. A single push therefore
covers both node types. The other "View Diagram" push, at line 4483, belongs to
`buildObjectSidebarMenu` and is not touched.

`openDocs` is destructured from `useSidebarTreeToolRuntime` at line 312, and
`BookOpen` is added to the existing `@lucide/vue` icon import (lines 13-57).

### Object browser removal

`ObjectBrowser.vue` loses the docs entry from the table menu (line 2669) and the
view menu (line 2724), the `openDocs` function (line 1466), and the now-orphaned
`BookOpen` import (line 9). The `canOpenDiagram` ternaries collapse back to the
single-element form they had before PR #5559.

### Gating

The new entry reuses the sidebar's existing `canOpenDiagram` computed
(line 3386): `!!activeNode.value.database && supportsSchemaDiagram(currentDatabaseType())`.

This is a deliberate compromise rather than a principled gate. Documentation and
diagrams are separate features; a driver that supported one but not the other
would be misrepresented. The principled alternative is a `docs` key in
`DATABASE_PRODUCT_CAPABILITY_KEYS`, but that list is backed by
`crates/dbx-core/assets/database-drivers.manifest.json`, shared with the Rust
side, and would require a per-support-level default plus per-driver overrides
across every driver.

Reusing the diagram gate keeps this change's visible behaviour identical to
v0.5.77 except for *where* the entry appears, which is the point of the change.
A capability key is worth proposing separately; it is called out in the PR
description rather than bundled here.

## Testing

New spec `apps/desktop/src/composables/__tests__/useSidebarTreeToolRuntime.docs.spec.ts`,
following the `shallowRef` node plus stub-store pattern of the neighbouring
`useSidebarTreeExportRuntime.spec.ts`:

- database node: `docsSource` receives `connectionId` and `database`, and
  `schema` is `undefined`
- schema node: `schema` is propagated
- node without `database`: `docsSource` is left untouched

No i18n work is required. `docs.title` was added to all eight locales by
PR #5559, so this change introduces no locale-drift exposure.

Verification:

```
pnpm typecheck
npx vitest run apps/desktop/src/composables apps/desktop/src/components/objects
```

## Delivery

Branch `fix/docs-menu-database-scope`, cut from `upstream/main` at `29fe57143`.
One commit, then a PR to `t8y2/dbx`.

No `VERSION` or `CHANGELOG.md` bump: this repository has no changelog, and
`package.json` version is managed by upstream's `scripts/release.mjs`. Version
numbers belong to the maintainer's release process, not to a contribution PR.
