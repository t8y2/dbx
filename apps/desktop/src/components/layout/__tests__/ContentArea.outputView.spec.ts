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
