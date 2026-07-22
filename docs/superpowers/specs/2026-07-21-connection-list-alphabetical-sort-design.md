# Connection List Alphabetical Sort Design

**Date:** 2026-07-21

## Goal

Add a connection-list sort control to the desktop sidebar. Users can view saved
connections by name in ascending or descending alphabetical order, without
destroying their existing group and drag-and-drop layout.

## Background

The source repository was searched before this change. Issue #72, "连接分组和拖拽排序",
is closed because DBX already supports groups and manual drag sorting. No issue
or announced plan covers alphabetical ordering of connection names.

The current sidebar builds its root tree from the persisted `SidebarLayout`.
That layout captures manual root and group ordering. Rewriting it for an
alphabetical view would silently discard a user's manual arrangement.

## Requirements

- provide ascending and descending connection-name ordering from the sidebar
- retain a way to return to the saved manual order
- sort connections both at the root and inside each connection group
- keep connection groups themselves in their saved order
- do not mutate the persisted drag-and-drop layout when changing display sort
- remember the selected sort mode across application restarts
- keep search, selection, expand/collapse state, and virtualized rendering
  working

## Chosen Approach

### Sort mode

Add `sidebarConnectionSortMode` to editor settings with three values:

- `manual` — existing persisted drag-and-drop order (default)
- `asc` — connection names from A to Z
- `desc` — connection names from Z to A

The setting is normalized on load and saved through the existing editor-settings
store, so old profiles safely default to `manual`.

### Display transformation

Create a pure sidebar utility that produces a display-only tree:

- it recursively visits only `connection-group` nodes
- at every such level, it sorts only sibling nodes whose type is `connection`
- it preserves the positions and order of group nodes and any non-connection
  nodes
- it copies only the group branches whose child order changes; stored tree nodes
  remain unmodified
- it uses an `Intl.Collator` with numeric, case-insensitive comparison; names
  that compare equally retain their manual relative order

`ConnectionTree.vue` uses this transformed tree before it applies the existing
search filter and flattening flow. This means all of the existing selection and
virtualization logic continues to operate on the currently visible order.

### User interface

Add a compact sort dropdown next to the existing sidebar locate and filter
controls. It exposes:

- Manual order
- Name: A–Z
- Name: Z–A

The active mode has an accessible label and visible selected state. New labels
are added to every supported locale, with fallback coverage for any locale that
does not yet provide a translation.

Manual drag-and-drop is disabled while either alphabetical sort is active. This
avoids a misleading interaction in which a successful drag immediately appears
to be undone by the active display sort. Switching back to `manual` restores
the untouched stored layout and drag behavior.

## Files And Boundaries

- `apps/desktop/src/lib/sidebar/connectionListSort.ts` — pure ordering utility
  and its Vitest coverage
- `apps/desktop/src/stores/settingsStore.ts` — typed default, normalization,
  and persistence update for the mode
- `apps/desktop/src/components/sidebar/ConnectionTree.vue` — dropdown,
  display-tree integration, and drag guard
- `apps/desktop/src/i18n/locales/*.ts` — sort-control labels

No Rust backend, connection storage schema, or sidebar-layout persistence code
changes. Sorting is entirely a frontend presentation preference.

## Error Handling And Compatibility

- missing, invalid, or legacy setting values normalize to `manual`
- empty trees and groups remain unchanged
- duplicate or equivalent names remain stable in their manual order
- filtering continues to run after display sorting, so disconnected-connection
  filtering has no new special case

## Testing

- unit-test ascending and descending ordering
- verify groups retain their relative order while root and nested connections
  sort independently
- verify manual mode returns original references/order and input trees are not
  mutated
- test editor-settings default, normalization, and persisted update behavior
- run targeted Vitest tests, frontend typecheck, Rust fast check, and local
  `make dev-fast` native startup

## Scope Boundaries

Included:

- connection-name alphabetical ascending/descending display sorting
- remembered sort mode
- grouped connection support

Not included:

- sorting databases, schemas, tables, or other tree objects
- replacing manual drag ordering
- changing connection configuration or the persisted sidebar layout format
- per-group independent sort preferences

## Success Criteria

- a user can choose A–Z or Z–A from the sidebar and see all connections sorted
  accordingly within their current groups
- manual ordering can be restored without data loss
- the chosen mode survives restart
- native local startup completes with the control present and functional
