# Query Result Run Tabs Design

## Context

DBX currently stores one displayed query result payload on each query tab:
`tab.result`, optional multi-statement `tab.results`, and `tab.activeResultIndex`.
Running a new query replaces that payload. The existing result buttons only switch
between tabular results produced by one execution, not between separate
executions.

The requested feature is to keep each completed query execution available as a
switchable result tab so users can compare different runs and continue editing
the currently visible result through the existing grid editing workflow.

## Goals

- After each completed query execution, append a result-run tab inside the query
  results pane.
- Let users switch between result-run tabs and see the corresponding result,
  execution summary, chart eligibility, and multi-statement result buttons.
- Preserve direct editing by continuing to render switched results through the
  existing `DataGrid` and data-grid editor pipeline.
- Keep SQL editor edits independent from result-run switching, so selecting an
  older result does not overwrite the user's current SQL draft.
- Keep the first implementation focused on query tabs and the current app
  session. Persist lightweight run metadata with open tabs, but avoid storing
  large result payloads directly in localStorage.

## Non-Goals

- Do not create top-level app tabs for every execution.
- Do not introduce a second grid editor implementation.
- Do not guarantee that every historical result survives a full app restart if
  the runtime result cache is unavailable or has been cleaned.
- Do not change table data tabs, object browsers, Redis/Mongo/etcd dedicated
  browser tabs, or saved SQL library behavior beyond compatibility with query
  tabs.

## Recommended Approach

Add a result-run layer to query tabs and map the selected run back onto the
existing result fields.

Each query tab gains:

- `resultRuns`: ordered result-run records for completed executions.
- `activeResultRunId`: the selected result-run record.

Each result-run record stores:

- Stable `id`.
- Display title, sequence number, executed SQL, and creation timestamp.
- `result`, `results`, and `activeResultIndex`.
- Result metadata used by the current grid and export flows, including
  `queryAnalysis`, `querySourceColumns`, `queryEditabilityReason`, `tableMeta`,
  pagination, sorting, count SQL, total row count state, and cache state.

When a run is selected, the query store copies that run's display payload into
the existing `tab.result`, `tab.results`, and related fields. This preserves
compatibility with `ContentArea.vue`, `DataGrid.vue`, summaries, charts, export,
pagination, sorting, and the existing cell editing path.

## Alternatives Considered

1. Store an independent result payload in a new UI component.
   This avoids mutating existing tab fields, but duplicates a large amount of
   DataGrid, pagination, export, and editability wiring.

2. Open a top-level query tab for each execution.
   This is simple to reason about, but it pollutes the main application tab bar
   and does not match the requested workflow of switching between execution
   results inside one query workspace.

3. Recommended: add a result-run layer and project the active run into the
   existing tab result fields.
   This keeps the implementation smaller, preserves current grid behavior, and
   limits UI changes to the results pane and query store state transitions.

## Data Flow

1. A user executes SQL from a query tab.
2. The query store starts execution as it does today, clearing only the currently
   projected display payload while keeping existing `resultRuns`.
3. When execution finishes, the query store creates a result-run record from the
   finished payload and selects it.
4. Selecting a result-run projects that run into the existing displayed result
   fields.
5. If the execution contains multiple tabular statement results, the existing
   statement-result selector continues to use `activeResultIndex`.
6. Metadata analysis completion updates both the currently projected tab fields
   and the selected result-run record when they still refer to the same
   execution.

## Editing Behavior

The SQL editor always remains the active draft for the query tab. Switching
result runs does not replace `tab.sql`.

The result grid remains editable when the active run has valid editability
metadata. The `DataGrid` cache key must include the query tab id, result-run id,
and statement result index. This prevents pending edits from one execution from
appearing on another execution's grid.

## UI Behavior

The results pane adds a compact run-tab strip before the existing result view
controls:

- A single run can be shown without taking much space.
- Multiple runs are displayed as horizontally scrollable buttons such as
  "Run 1", "Run 2", and "Run 3".
- The selected run button uses the same visual language as existing result
  buttons.
- Existing "Table Data", statement-result buttons, "Execution Summary", chart,
  explain, grid options, refresh, and hide-results controls keep their current
  behavior.

The initial implementation keeps run labels generated from execution order.
Manual rename, close individual run, and pin run actions can be added later if
needed.

## Persistence and Cache

Open-tab persistence stores lightweight run metadata and cache handles only. It
does not write large result rows to localStorage.

Runtime result caching extends the existing `tabResultCache` pattern where
practical. Session ids must not be persisted. If a cached run cannot be restored,
the UI keeps enough metadata to show that the historical result is no
longer available and allow new executions to continue normally.

## Error Handling

Failed executions create a run containing the existing error-shaped result
payload. This lets users switch back to past errors and use existing "Fix with
AI" behavior on the active error result.

If a run's cached payload is missing, selecting it must not crash the results
pane. The store clears the projected payload for that run and exposes a
recoverable empty or missing-cache state.

## Testing

Use test-first implementation for store and persistence behavior.

Core tests:

- Two successful query executions create two result-run records and select the
  latest run.
- Switching result runs restores the corresponding displayed `result`.
- A multi-statement execution keeps statement-result switching within its run.
- Editing or pending-grid cache keys include the result-run id and do not bleed
  between runs.
- Starting a new execution clears only the projected display payload, not the
  previous run list.
- Open-tab serialization persists lightweight run metadata and omits row payloads
  from localStorage.
- Error executions create switchable runs.

Regression checks:

- Existing single-result and multi-result behavior still works when only one run
  exists.
- Existing result cache eviction still releases live sessions.
- Current SQL editor content is not overwritten when switching runs.

## Implementation Boundaries

Likely touched files:

- `apps/desktop/src/types/database.ts`
- `apps/desktop/src/stores/queryStore.ts`
- `apps/desktop/src/lib/openTabsPersistence.ts`
- `apps/desktop/src/lib/tabResultCache.ts`
- `apps/desktop/src/lib/tabPresentation.ts`
- `apps/desktop/src/components/layout/ContentArea.vue`
- `apps/desktop/src/i18n/locales/en.ts`
- `apps/desktop/src/i18n/locales/zh-CN.ts`
- focused tests under `packages/app-tests/`

The implementation avoids unrelated refactors and does not restore the
unrelated autostash from the earlier table-structure work.
