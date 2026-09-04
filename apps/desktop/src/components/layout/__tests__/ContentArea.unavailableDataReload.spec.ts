import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

describe("ContentArea restored data-tab refresh", () => {
  it("routes both no-data refresh entries through the filter-preserving helper (#7963)", () => {
    // 裸 emit("reload") 会让 onReloadData 把缺省的 whereInput/orderBy 当成
    // “用户已清空”，刷新后退回整张表的数据。
    expect(contentAreaSource).not.toContain(`@click="emit('reload')"`);
    expect(contentAreaSource).not.toMatch(/\bemit\("reload"\)\s*;/);
    expect(contentAreaSource).toContain(`@click="reloadUnavailableDataTab()"`);
    expect(contentAreaSource).toContain("reloadUnavailableDataTab();");
  });

  it("passes the restored tab's own WHERE/ORDER BY into the reload event", () => {
    expect(contentAreaSource).toContain("const { whereInput, orderBy } = restoredDataTabReloadFilters(props.activeTab);");
    // tabId-first contract: the reload event carries the owning tab's id.
    expect(contentAreaSource).toContain(`emit("reload", props.activeTab.id, undefined, whereInput, orderBy);`);
  });
});
