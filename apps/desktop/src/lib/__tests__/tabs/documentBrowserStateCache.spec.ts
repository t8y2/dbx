import { describe, expect, it } from "vitest";
import { clearDocumentBrowserState, restoreDocumentBrowserState, saveDocumentBrowserState, type DocumentBrowserStateSnapshot } from "@/lib/tabs/documentBrowserStateCache";

function snapshot(page: number): DocumentBrowserStateSnapshot {
  return {
    filterInput: `{"page":${page}}`,
    sortInput: `{"f":${page}}`,
    appliedDocumentFilter: page % 2 === 0 ? { status: "active" } : null,
    documentFilterRules: page % 2 === 0 ? [{ id: `rule-${page}`, fieldName: "status", mode: "equals", rawValue: "active", conjunction: "AND" }] : [],
    page,
  };
}

describe("documentBrowserStateCache", () => {
  it("round-trips a snapshot for the same key", () => {
    saveDocumentBrowserState("round-trip", snapshot(3));

    expect(restoreDocumentBrowserState("round-trip")).toEqual(snapshot(3));
  });

  it("returns undefined for an unknown key", () => {
    expect(restoreDocumentBrowserState("missing")).toBeUndefined();
  });

  it("keeps the most recent write for a key", () => {
    saveDocumentBrowserState("overwrite", snapshot(1));
    saveDocumentBrowserState("overwrite", snapshot(2));

    expect(restoreDocumentBrowserState("overwrite")).toEqual(snapshot(2));
  });

  it("evicts the oldest entry beyond 32 keys", () => {
    for (let index = 0; index < 33; index += 1) {
      saveDocumentBrowserState(`evict-${index}`, snapshot(index));
    }

    expect(restoreDocumentBrowserState("evict-0")).toBeUndefined();
    expect(restoreDocumentBrowserState("evict-1")).toBeDefined();
    expect(restoreDocumentBrowserState("evict-32")).toBeDefined();
  });

  it("treats a restore as recency so a touched entry survives eviction", () => {
    for (let index = 0; index < 32; index += 1) {
      saveDocumentBrowserState(`touch-${index}`, snapshot(index));
    }
    expect(restoreDocumentBrowserState("touch-0")).toEqual(snapshot(0));
    saveDocumentBrowserState("touch-new", snapshot(99));

    expect(restoreDocumentBrowserState("touch-0")).toBeDefined();
    expect(restoreDocumentBrowserState("touch-1")).toBeUndefined();
  });

  it("clears a key on demand", () => {
    saveDocumentBrowserState("clear-me", snapshot(4));
    clearDocumentBrowserState("clear-me");

    expect(restoreDocumentBrowserState("clear-me")).toBeUndefined();
  });
});
