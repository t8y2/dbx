# SQL Semantic Completion DBeaver References

This change uses the local DBeaver checkout at `/Users/skyler/VsCodeProjects/dbeaver` as the behavioral reference for semantic SQL completion.

Key files reviewed:

- `plugins/org.jkiss.dbeaver.ui.editors.sql/src/org/jkiss/dbeaver/ui/editors/sql/syntax/SQLCompletionProcessor.java`
  - Selects semantic, legacy, or combined completion paths and handles asynchronous proposal jobs.
- `plugins/org.jkiss.dbeaver.model.sql/src/org/jkiss/dbeaver/model/sql/semantics/completion/SQLQueryCompletionContext.java`
  - Builds completion proposals from syntax inspection, lexical scope, row-source context, and cursor offset.
- `plugins/org.jkiss.dbeaver.model.sql/src/org/jkiss/dbeaver/model/sql/semantics/context/SQLQueryRowsSourceContext.java`
  - Tracks table sources, aliases, dynamic CTE sources, unresolved sources, and known-source collections.
- `plugins/org.jkiss.dbeaver.model.sql/src/org/jkiss/dbeaver/model/sql/semantics/completion/SQLQueryCompletionAnalyzer.java`
  - Converts semantic completion items into editor proposals with replacement ranges, descriptions, images, and scoring.

DBX intentionally implements a smaller frontend semantic model first. The immediate goal is not DBeaver parser parity; it is to move cursor intent, row-source resolution, CTE/subquery handling, and fallback confidence into one reusable layer before routing completion, diagnostics, and navigation through it.

## Completion Assistant Field Audit

The semantic completion scopes added in this change fit the existing DBX completion assistant and item-builder fields:

- Table/schema/catalog lookup maps to `suggestTables`, `qualifier`, `qualifierParts`, `schemas`, and existing table metadata lookup methods.
- Routine/package lookup maps to `suggestRoutines`, `exclusiveRoutineSuggestions`, `qualifier`, and existing completion object lookup methods.
- Alias, CTE, subquery, INSERT target, UPDATE target, join, and star column lookup maps to `referencedTables`, `columns`, `insertTable`, `updateTarget`, `deleteTarget`, `onStar`, and `columnsByTable`.
- Projection aliases map to `prioritizeSelectAliases` and `selectAliases`.
- Fallback confidence maps to the existing legacy `getSqlCompletionContext()` path without requiring broad all-column scans.

No backend/API field gap was found for the current semantic scopes. The implementation therefore keeps the Java/Rust assistant protocol unchanged and limits new work to frontend semantic context, conversion, and tests.
