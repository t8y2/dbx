import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

describe("ContentArea completed query output", () => {
  it("re-evaluates the no-table fallback when tab activation resets the shared view", () => {
    expect(contentAreaSource).toContain("props.activeTab.isExecuting, props.activeOutputView] as const");
    expect(contentAreaSource).toContain('emit("update:activeOutputView", result ? defaultViewForResult(result) : "summary")');
  });
});

describe("ContentArea Mongo tab reuse", () => {
  it("remounts the document browser when the active tab changes collections", () => {
    expect(contentAreaSource).toContain(':key="`${activeTab.id}:${activeTab.sql}`"');
  });
});

describe("ContentArea query result grid", () => {
  it("passes connection and per-run count SQL to the query-tab grid so the total can be re-counted", () => {
    const countSqlProp = ':count-sql="activeTab.resultCountSql"';
    const countSqlIndex = contentAreaSource.indexOf(countSqlProp);
    expect(countSqlIndex).toBeGreaterThan(-1);
    // Robust string-matching: anchor on the per-run count SQL and walk back to
    // the enclosing DataGrid so the test does not depend on DataGrid ordering
    // while staying in readFileSync format.
    const dataGridIndex = contentAreaSource.lastIndexOf("<DataGrid", countSqlIndex);
    expect(dataGridIndex).toBeGreaterThan(-1);
    const queryGridBlock = contentAreaSource.slice(dataGridIndex, countSqlIndex + 900);
    expect(queryGridBlock).toContain("<DataGrid");
    expect(queryGridBlock).toContain(':connection-id="activeResultConnectionId"');
    expect(queryGridBlock).toContain(':count-sql="activeTab.resultCountSql"');
    expect(queryGridBlock).toContain(':total-row-count="activeTab.resultTotalRowCount"');
    expect(queryGridBlock).toContain(':total-row-count-loading="activeTab.resultTotalRowCountLoading"');
  });
});
