import { beforeEach, describe, expect, it } from "vitest";
import {
  beginClosingBrowserState,
  clearDocumentBrowserState,
  clearGridFsBrowserState,
  MAX_DATA_ENTRIES,
  MAX_RESTORED_DOCUMENT_ROWS,
  resetBrowserStateCaches,
  restoreDocumentBrowserState,
  restoreGridFsBrowserState,
  saveDocumentBrowserState,
  saveGridFsBrowserState,
  type DocumentBrowserDataSnapshot,
  type DocumentBrowserStateSnapshot,
} from "@/lib/tabs/documentBrowserStateCache";

function snapshot(page: number): DocumentBrowserStateSnapshot {
  return {
    filterInput: `{"page":${page}}`,
    sortInput: `{"f":${page}}`,
    appliedDocumentFilter: page % 2 === 0 ? { status: "active" } : null,
    documentFilterRules: page % 2 === 0 ? [{ id: `rule-${page}`, fieldName: "status", mode: "equals", rawValue: "active", conjunction: "AND" }] : [],
    page,
  };
}

function data(rowCount: number, signature = "sig"): DocumentBrowserDataSnapshot {
  return {
    signature,
    documents: Array.from({ length: rowCount }, (_, index) => ({ _id: String(index) })),
    copyDocuments: [],
    copyDocumentsAvailable: false,
    gridColumns: ["_id"],
    gridColumnTypes: ["objectId"],
    total: rowCount,
    totalIsExact: true,
    paginationTotal: rowCount,
    selectedIdx: null,
  };
}

beforeEach(() => {
  resetBrowserStateCaches();
});

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

  it("round-trips a row payload alongside the conditions", () => {
    saveDocumentBrowserState("with-data", { ...snapshot(1), data: data(2) });

    expect(restoreDocumentBrowserState("with-data")?.data?.documents).toHaveLength(2);
  });

  it("drops a stored payload on a conditions-only save", () => {
    saveDocumentBrowserState("drop-data", { ...snapshot(1), data: data(2) });
    saveDocumentBrowserState("drop-data", snapshot(1));

    expect(restoreDocumentBrowserState("drop-data")?.data).toBeUndefined();
  });

  it("drops a payload larger than the row bound but keeps the conditions", () => {
    saveDocumentBrowserState("too-big", { ...snapshot(2), data: data(MAX_RESTORED_DOCUMENT_ROWS + 1) });

    const restored = restoreDocumentBrowserState("too-big");
    expect(restored?.data).toBeUndefined();
    expect(restored?.filterInput).toBe(snapshot(2).filterInput);
  });

  it("keeps payloads only for the most recently used tabs", () => {
    for (let index = 0; index < MAX_DATA_ENTRIES + 2; index += 1) {
      saveDocumentBrowserState(`payload-${index}`, { ...snapshot(index), data: data(1) });
    }

    expect(restoreDocumentBrowserState("payload-0")?.data).toBeUndefined();
    expect(restoreDocumentBrowserState("payload-0")?.filterInput).toBe(snapshot(0).filterInput);
    expect(restoreDocumentBrowserState(`payload-${MAX_DATA_ENTRIES + 1}`)?.data).toBeDefined();
  });

  it("blocks the unmount capture from resurrecting a closed tab", () => {
    saveDocumentBrowserState("closing", { ...snapshot(1), data: data(1) });
    beginClosingBrowserState("closing");
    // DocumentBrowser unmounts after the store removed the tab and writes again.
    saveDocumentBrowserState("closing", { ...snapshot(1), data: data(1) });

    expect(restoreDocumentBrowserState("closing")).toBeUndefined();
  });
});

describe("gridFsBrowserStateCache", () => {
  it("round-trips conditions and rows", () => {
    saveGridFsBrowserState("gridfs-a", { filterInput: "{}", sortInput: "", signature: "sig", rows: [{ name: "fs" }] });

    const restored = restoreGridFsBrowserState<{ name: string }>("gridfs-a");
    expect(restored?.rows).toEqual([{ name: "fs" }]);
    expect(restored?.signature).toBe("sig");
  });

  it("drops an oversized listing but keeps the conditions", () => {
    const rows = Array.from({ length: MAX_RESTORED_DOCUMENT_ROWS + 1 }, (_, index) => ({ name: String(index) }));
    saveGridFsBrowserState("gridfs-big", { filterInput: "{}", sortInput: "", signature: "sig", rows });

    const restored = restoreGridFsBrowserState<{ name: string }>("gridfs-big");
    expect(restored?.rows).toBeUndefined();
    expect(restored?.signature).toBeUndefined();
    expect(restored?.filterInput).toBe("{}");
  });

  it("clears a key on demand and on close", () => {
    saveGridFsBrowserState("gridfs-clear", { filterInput: "", sortInput: "" });
    clearGridFsBrowserState("gridfs-clear");
    expect(restoreGridFsBrowserState("gridfs-clear")).toBeUndefined();

    saveGridFsBrowserState("gridfs-closing", { filterInput: "", sortInput: "" });
    beginClosingBrowserState("gridfs-closing");
    saveGridFsBrowserState("gridfs-closing", { filterInput: "", sortInput: "" });
    expect(restoreGridFsBrowserState("gridfs-closing")).toBeUndefined();
  });
});
