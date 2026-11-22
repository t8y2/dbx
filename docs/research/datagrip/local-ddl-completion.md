# DataGrip local DDL completion: independently documented behavior

Reference: DataGrip 2026.1.3, build `DB-261.24374.56`. Target dialects are PostgreSQL, MySQL, and SQLite. This is a behavioral specification for DBX's independent implementation; no DataGrip source or binary artifacts are included.

## Evidence

- REA recorded the installed application inventory. JVM signatures/bytecode and local decompilation identify the model and cache ownership.
- DataGrip's real `inspect.sh` parser/resolve pipeline ran 27 scenarios (9 per dialect) with zero failing inspection processes. Results cover SELECT/JOIN, aliases, quoted names, CTAS, ALTER ADD, DROP, forward references, duplicates, and incomplete DDL.
- `SqlResolveInspection.json` records unresolved references independently of parser syntax errors. No output file after a successful run means no resolve-inspection problems; this is distinguished from a failed inspection.

## File-local model

`SqlFileImpl` builds a file-local mirror model rather than requiring executed database objects:

1. `calcDdl()` collects stub/PSI DDL elements allowed by the active dialect, excluding local-only definitions from the global DDL list.
2. `calcState()` walks those DDL elements in document order, tracking initial/current context and `USE` where script mode supports it.
3. `addDefinitionToMap()` derives object kind, quoted/cased name, namespace path, and parent links. It creates/reuses mirror groups and records delegates for PSI definitions.
4. `processDeclarations()` exposes the resulting symbols to SQL scope processors. Namespaces are expanded through declaration/resolve conditions; non-namespace symbols are offered directly.
5. `SqlCompletionContributor` registers reference-expression and JOIN providers. Completion consumes the same resolve/declaration model, so a table does not need to exist in remote metadata or have been executed.

The mirror is not a connection-level catalog mutation. It belongs to the SQL file and is rebuilt from its current text.

## Columns from CREATE TABLE

`SqlCreateTableStatementImpl.getColumns()` combines:

- declared `SqlColumnDefinition` elements;
- additional dialect columns;
- query-derived columns for CTAS, including explicit column aliases.

`calcColumns()` uses recursion protection and cached values tied to the file's maximal dependencies. Query-column caching additionally observes SQL modification count. Column attributes such as primary/foreign key, auto-generation, and nullability are derived from declared constraints and dialect rules.

For DBX, the local overlay should parse qualified/quoted table names, top-level column definitions, table-level constraint exclusion, CTAS aliases where supported, and ALTER ADD column definitions. It must not mistake `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `CHECK`, or other constraints for columns.

## Visibility observed in DataGrip

| Scenario | Observed result | DBX overlay rule |
| --- | --- | --- |
| CREATE followed by SELECT/JOIN | Tables and columns resolve in all three dialects | Supported |
| Alias and self/multi-table JOIN | Aliased columns resolve | Reuse existing semantic row sources and aliases |
| Quoted/schema-qualified names | PostgreSQL/MySQL/SQLite cases resolve | Preserve quote and qualifier identity |
| CTAS | Query output column `value` resolves | Support simple declared projection names/aliases; complex expressions are best-effort |
| ALTER ADD | Added column resolves | Apply supported ADD COLUMN definitions to the existing local table |
| DROP | Later local reference still resolves | Do not treat unexecuted DROP as an execution-state change; document this behavior |
| Reference before CREATE | Earlier reference resolves | Build the overlay from the whole document, not only preceding statements |
| Duplicate CREATE | The added column from the second definition does not resolve | First valid local definition wins; later duplicates do not replace it |
| Incomplete CREATE | Declared columns can resolve despite incomplete SQL | Best-effort parsing of complete column prefixes; never block the editor |

This is an editor-language model, not a transactional simulation of database execution. Execution success/failure must not directly add/remove the text-derived overlay. Real catalog metadata is refreshed separately after successful execution.

## Cache and invalidation

`SqlFileImpl` creates cached DDL, state, declarations, and resolve-cache values. Their dependencies include the file and its maximal dependencies, including data-source modification counts. `clearCaches()` clears state/declarations/DDL/resolve-cache and delegates to the platform implementation. `SqlFileImpl.mergeRoots()` combines mirrors when multiple SQL files are in scope.

DBX's overlay should remain a pure function of the current editor text, dialect, and context. Existing completion analysis caches already invalidate on a new document. Do not write overlay objects into `connectionStore` or share them across tabs/connections. Execution success or failure does not directly mutate the overlay; text edits and context changes do.

## DBX implementation contract

Add `buildSqlLocalSchemaOverlay(sql, options)` returning a structured-clone-friendly table/column array with quoted/qualified identity and source spans. Add the result to `SqlCompletionAnalysisResult.localSchema` and merge it into both local and asynchronous completion paths.

- Local definitions take precedence over matching remote metadata.
- Existing `buildSqlCompletionItemsFromContext` and semantic row-source/alias/JOIN handling remain the item-building boundary.
- Local and async paths must produce the same candidates; remote failure must not remove local candidates.
- Full-document analysis runs inside the existing completion worker and has explicit size/performance limits.

## Verification matrix

The final PR records exact tests and remaining limits. The implementation is not presented as a full procedural-SQL scope engine. Dynamic SQL, complex CTAS type inference, routines, triggers, cross-file schema models, and execution-dependent catalog state are outside the first phase.

## Local verification

- 17 overlay tests cover all three dialects, quoted/qualified identifiers, constraints, CTAS, ALTER ADD, duplicates, incomplete DDL, comments/strings, edit-sized input, structured cloning, and the 250,000-character budget.
- The editor suite covers equivalent local/async candidates, empty or failed remote metadata, alias/JOIN behavior, tab isolation, and case-distinct quoted PostgreSQL tables.
- Final targeted run: 3 test files, 179 tests passed. Direct `vue-tsc --noEmit --project apps/desktop/tsconfig.json`, `pnpm lint`, and the production Vite build passed. Lint reports only pre-existing warnings.
