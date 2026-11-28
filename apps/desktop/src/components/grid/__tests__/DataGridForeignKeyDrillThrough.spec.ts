import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../layout/ContentArea.vue", import.meta.url), "utf8");
const postgresSource = readFileSync(new URL("../../../../../../crates/dbx-driver-postgres/src/postgres.rs", import.meta.url), "utf8");
const queryStoreSource = readFileSync(new URL("../../../stores/queryStore.ts", import.meta.url), "utf8");
const sourceForeignKeysSource = readFileSync(new URL("../../../composables/useDataGridSourceForeignKeys.ts", import.meta.url), "utf8");
const navigationTargetsSource = readFileSync(new URL("../../../composables/useNavigationTargets.ts", import.meta.url), "utf8");

describe("DataGrid foreign-key drill-through (same pane, both render modes)", () => {
  it("declares the owning-tab prop that switches navigation to in-place", () => {
    expect(dataGridSource).toContain("foreignKeyNavigationTabId?: string;");
  });

  it("renders the FK jump button in the DOM hover overlay (canvas parity)", () => {
    expect(dataGridSource).toContain('v-if="cellForeignKeyInfo(item.displayIndex, col.actualColIdx)"');
    expect(dataGridSource).toContain('@click.stop="navigateToForeignKeyCell(item.displayIndex, col.actualColIdx)"');
    expect(dataGridSource).toContain("t('grid.foreignKeyNavigate', { table: cellForeignKeyInfo(item.displayIndex, col.actualColIdx)!.ref_table })");
  });

  it("keeps the FK jump button in the canvas hover overlay", () => {
    expect(dataGridSource).toContain('v-if="canvasDetailButtonCell.foreignKey"');
    expect(dataGridSource).toContain('@click.stop="navigateToForeignKeyCell(canvasDetailButtonCell.rowIndex, canvasDetailButtonCell.actualColIdx)"');
  });

  it("routes the jump in place: data tab reuses its tab, query tab executes in its results pane", () => {
    expect(dataGridSource).toContain("const owningTabId = props.foreignKeyNavigationTabId;");
    expect(dataGridSource).toContain("openTableTarget(navigationTarget, { reuseTabId: owningTabId, drillBack: true, drillBackView })");
    expect(dataGridSource).toContain("executeTableTargetInQueryTab(navigationTarget, { tabId: owningTabId, drillBack: true, drillBackView })");
    // legacy fallback when no owning tab is provided (e.g. embedded grids)
    expect(dataGridSource).toContain("await openTableTarget(navigationTarget);");
  });

  it("gates the in-place drill on the grid's own unsaved-edit state (routing decisions in foreignKeyDrillRouting)", () => {
    // routing itself is behaviour-tested in dataGridForeignKeyNavigation.spec;
    // here we pin the wiring: the grid consults its own hasPendingChanges
    // (the tab-level pendingDataChangeCount only syncs on table-data, so a
    // results grid's edits are invisible to any tab-based gate)
    expect(dataGridSource).toContain("const route = foreignKeyDrillRouting({ context: props.context, owningTabId, hasPendingChanges: hasPendingChanges.value });");
    expect(dataGridSource).toContain('if (route === "data-tab-in-place" && owningTabId) {');
    expect(dataGridSource).toContain('if (route === "query-tab-in-place" && owningTabId) {');
  });

  it("records a restore point before rewriting the pane and offers a back control", () => {
    // navigation entries push the drill-back stack only on the in-place drill paths
    expect(navigationTargetsSource).toContain("if (options.drillBack && canReuse && reuseTab) {");
    expect(navigationTargetsSource).toContain("pushForeignKeyDrillBack(reuseTab.id, {");
    expect(navigationTargetsSource).toContain('pushForeignKeyDrillBack(options.tabId, { restore: { kind: "queryResult", sql: previousDisplayedSql, page: previousPage }, view: options.drillBackView, arrivedSql: sql, label: target.tableName });');
    // a failed in-place open must withdraw the restore point it pushed (no dead entries)
    expect(navigationTargetsSource).toContain("if (pushedDrillBackEntry && !firstExecuteStarted && reuseTab) removeForeignKeyDrillBackEntry(reuseTab.id, pushedDrillBackEntry);");
    expect(navigationTargetsSource).toContain("if (pushedDrillBackEntry) removeForeignKeyDrillBackEntry(options.tabId, pushedDrillBackEntry);");
    // the grid pops the stack through the same executors; the restore replays the
    // captured sort/page state and re-runs the previous result page
    expect(dataGridSource).toContain("await openTableTarget(popped.restore.target, { reuseTabId: tabId, restore: true });");
    expect(dataGridSource).toContain("await executeSqlInQueryTabResults(tabId, popped.restore.sql, { pagination: popped.restore.page });");
    expect(dataGridSource).toContain("replayForeignKeyDrillBackView(popped.view);");
    expect(dataGridSource).toContain('data-toolbar-action="foreignKeyDrillBack"');
    expect(dataGridSource).toContain("peekForeignKeyDrillBack(tabId, (entry) => foreignKeyDrillBackEntryMatchesTab(entry, tab))");
    // 跳转/返回的过渡期保护：发起返回后把剩余栈顶标记为等待落地，链式返回才走得通
    expect(dataGridSource).toContain("markForeignKeyDrillBackPendingArrival(tabId);");
    // Alt+← 网格内返回：仅在持有可返回条目时消费，不拦截其它 Alt+← 行为
    expect(dataGridSource).toContain('event.key === "ArrowLeft" && foreignKeyDrillBackTarget.value');
    expect(dataGridSource).toContain("await goForeignKeyDrillBack();");
  });

  it("resolves foreign keys per source table for multi-source (JOIN) results", () => {
    expect(dataGridSource).toContain("props.queryDisplaySourceColumns?.some((ref) => !!ref?.tableName)");
    expect(dataGridSource).toContain("foreignKeyAssociationForRef({");
    expect(dataGridSource).toContain("useDataGridSourceForeignKeys({ props })");
  });

  it("ContentArea passes the owning tab on both grid mounts", () => {
    expect(contentAreaSource.match(/:foreign-key-navigation-tab-id="activeTab\.id"/g)).toHaveLength(2);
  });
});

describe("postgres FK drill-through (unqualified sources)", () => {
  it("resolves an unqualified table through the search_path, not a hard public default", () => {
    // Unqualified FROM sources on postgres reach the backend schema-less (the
    // frontend keeps them schema-less so the connection's search_path decides,
    // see queryStore's useCurrentPostgresSchema). `n.nspname = ''` matches
    // nothing, but a hard "public" default matched the WRONG same-named table
    // under a custom search_path. The backend must resolve the name the way an
    // unqualified query would: first search_path schema that holds the table,
    // falling back to current_schema(). Behavioural coverage against a live
    // database: crates/dbx-driver-postgres/tests/foreign_key_search_path.rs
    // (DBX_TEST_POSTGRES_URL).
    const fn = postgresSource.slice(postgresSource.indexOf("pub async fn list_foreign_keys("), postgresSource.indexOf("pub async fn list_opengauss_foreign_keys"));
    expect(fn).toContain("resolve_unqualified_table_schema(&client, table).await");
    expect(fn).not.toContain('if schema.is_empty() { "public" }');
    // the resolver itself: search-path schemas in path order, current_schema() fallback
    const resolver = postgresSource.slice(postgresSource.indexOf("const POSTGRES_RESOLVE_SEARCH_PATH_SCHEMA_SQL"), postgresSource.indexOf("pub async fn list_foreign_keys("));
    expect(resolver).toContain("n.nspname = ANY (pg_catalog.current_schemas(false))");
    expect(resolver).toContain("pg_catalog.array_position(pg_catalog.current_schemas(false), n.nspname)");
    expect(resolver).toContain("pg_catalog.current_schema()::text");
  });

  it("matches the schema exactly in the FK query (why the default is load-bearing)", () => {
    const sql = postgresSource.slice(postgresSource.indexOf("fn postgres_foreign_keys_sql()"), postgresSource.indexOf("// Pre-9.4 sibling"));
    expect(sql).toContain("n.nspname = $1 AND c.relname = $2");
  });

  it("frontend keeps unqualified postgres sources schema-less and fetches FKs with that empty schema", () => {
    // queryStore deliberately resolves unqualified postgres names through the
    // connection's search_path (empty metadata schema), and the per-source FK
    // loader passes that schema through — the backend default above is what
    // makes the pair work on postgres (mysql folds schema into the catalog,
    // which is why it never showed the bug).
    expect(queryStoreSource).toContain("useCurrentPostgresSchema");
    expect(queryStoreSource).toContain("Keep the metadata request unqualified");
    expect(sourceForeignKeysSource).toContain('identity.schema ?? ""');
  });

  it("query-tab drill does not inject large-value preview marker columns", () => {
    // Marker columns (__DBX_LARGE_VALUE_BYTES_*) are stripped server-side only
    // for table-data executions; on a query tab they surfaced as ghost columns
    // (and would again on every sort/refresh re-run of resultBaseSql, so an
    // execution flag could not fix it either).
    const fn = navigationTargetsSource.slice(navigationTargetsSource.indexOf("async function executeTableTargetInQueryTab"), navigationTargetsSource.indexOf("async function openLineageTarget"));
    expect(fn).toContain("buildTableSelectSql({");
    expect(fn).not.toContain("tableDataLargeValuePreviewOptions");
  });
});
