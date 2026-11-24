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
    expect(dataGridSource).toContain("openTableTarget(navigationTarget, { reuseTabId: props.foreignKeyNavigationTabId, drillBack: true })");
    expect(dataGridSource).toContain("executeTableTargetInQueryTab(navigationTarget, { tabId: props.foreignKeyNavigationTabId, drillBack: true })");
    // legacy fallback when no owning tab is provided (e.g. embedded grids)
    expect(dataGridSource).toContain("await openTableTarget(navigationTarget);");
  });

  it("records a restore point before rewriting the pane and offers a back control (mod 43)", () => {
    // navigation entries push the drill-back stack only on the in-place drill paths
    expect(navigationTargetsSource).toContain("if (options.drillBack && canReuse && reuseTab) {");
    expect(navigationTargetsSource).toContain("pushForeignKeyDrillBack(reuseTab.id, {");
    expect(navigationTargetsSource).toContain('pushForeignKeyDrillBack(options.tabId, { restore: { kind: "queryResult", sql: previousDisplayedSql }, arrivedSql: sql, label: target.tableName });');
    // the grid pops the stack through the same executors (no new-tab fallback on back)
    expect(dataGridSource).toContain("await openTableTarget(popped.restore.target, { reuseTabId: tabId });");
    expect(dataGridSource).toContain("await executeSqlInQueryTabResults(tabId, popped.restore.sql);");
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
  it("defaults an empty schema to public in the postgres list_foreign_keys backend", () => {
    // Unqualified FROM sources on postgres reach the backend schema-less;
    // the pg_constraint query matches n.nspname exactly, so without this
    // default every postgres query result silently resolved zero FKs.
    const fn = postgresSource.slice(postgresSource.indexOf("pub async fn list_foreign_keys("), postgresSource.indexOf("pub async fn list_opengauss_foreign_keys"));
    expect(fn).toContain('let schema = if schema.is_empty() { "public" } else { schema };');
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
