import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

function functionSource(name: string, endMarker: string): string {
  const start = contentAreaSource.indexOf(`function ${name}(`);
  const end = contentAreaSource.indexOf(endMarker, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return contentAreaSource.slice(start, end);
}

describe("ContentArea result-tab view state handoff", () => {
  it("dispatches the pre-switch boundary before changing the result index", () => {
    const source = functionSource("selectResultItem", "function executionSummaryItemRange(");
    expect(source.indexOf("dispatchBeforeResultTabSwitch()")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("dispatchBeforeResultTabSwitch()")).toBeLessThan(source.indexOf("queryStore.setActiveResultIndex"));
  });

  it("dispatches the pre-switch boundary before changing the result run", () => {
    const source = functionSource("selectResultRun", "/**\n * 点击结果标签");
    expect(source.indexOf("dispatchBeforeResultTabSwitch()")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("dispatchBeforeResultTabSwitch()")).toBeLessThan(source.indexOf("queryStore.setActiveResultRun"));
  });

  it("uses the shared before-tab-switch event consumed by DataGrid", () => {
    const helper = functionSource("dispatchBeforeResultTabSwitch", "async function selectResultRunFromTab");
    expect(helper).toContain('new CustomEvent("dbx:before-tab-switch"');
    expect(helper).toContain("fromTabId: props.activeTab.id");
  });
});
