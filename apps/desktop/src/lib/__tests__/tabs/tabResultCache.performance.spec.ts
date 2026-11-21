import { decode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { decodeTabResultSnapshot, encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import type { QueryResult } from "@/types/database";

function createResult(rowCount: number): QueryResult {
  return {
    columns: ["id", "name", "enabled"],
    rows: Array.from({ length: rowCount }, (_, index) => [index, `row-${index}`, index % 2 === 0]),
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

describe("result cache serialization work", () => {
  it.each([
    { columns: [], rows: [] },
    { columns: [], rows: [[]] },
    { columns: ["first", "second"], rows: [[1], []] },
  ])("preserves empty and ragged result shapes: %j", ({ columns, rows }) => {
    const encoded = encodeTabResultSnapshot({ result: { columns, rows, affected_rows: 0, execution_time_ms: 0 }, cachedAt: 1 });
    expect(decodeTabResultSnapshot(encoded)?.result?.rows).toEqual(rows.map((row) => columns.map((_, columnIndex) => row[columnIndex] ?? null)));
  });

  it("does not repeatedly copy column vectors while cleaning optional metadata", () => {
    const rowCount = 1000;
    const result = createResult(rowCount);
    let fullLengthMaps = 0;
    const originalMap = Array.prototype.map;
    const mapSpy = vi.spyOn(Array.prototype, "map").mockImplementation(function (this: unknown[], callback, thisArg) {
      if (this.length === rowCount) fullLengthMaps += 1;
      return originalMap.call(this, callback, thisArg);
    });
    let encoded: Uint8Array;
    try {
      encoded = encodeTabResultSnapshot({ result, cachedAt: 1 });
    } finally {
      mapSpy.mockRestore();
    }

    expect(fullLengthMaps).toBeLessThanOrEqual(result.columns.length);
    expect(decodeTabResultSnapshot(encoded)?.result?.rows).toEqual(result.rows);
  });

  it("reads each source row once when converting a wide result to columns", () => {
    const result = createResult(100);
    let rowReads = 0;
    result.rows = new Proxy(result.rows, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const encoded = encodeTabResultSnapshot({ result, cachedAt: 1 });

    expect(rowReads).toBe(result.rows.length);
    expect(decodeTabResultSnapshot(encoded)?.result?.rows).toEqual(createResult(100).rows);
  });

  it("preserves the version-1 payload and metadata cleanup for results and saved runs", () => {
    const result = createResult(2);
    result.rows = [
      [1, "", false],
      [2, null, true],
    ];
    result.session_id = "live-session";
    result.mongo_documents = [{ retained: null, omitted: undefined, nested: { empty: undefined, values: [null, undefined, 0] }, date: new Date(0) }];
    const encoded = encodeTabResultSnapshot({
      result,
      results: [result],
      resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result, results: [result] }],
      cachedAt: 1,
    });
    const envelope = decode(encoded) as any;
    const expectedResult = {
      columns: ["id", "name", "enabled"],
      columnValues: [
        [1, 2],
        ["", null],
        [false, true],
      ],
      rowCount: 2,
      mongo_documents: [{ retained: null, nested: { values: [null, null, 0] }, date: {} }],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    expect(envelope).toEqual({
      magic: "DBX_TAB_RESULT_CACHE",
      version: 1,
      codec: "msgpack-columnar",
      cachedAt: 1,
      rowCount: 2,
      columnCount: 3,
      payload: {
        result: expectedResult,
        results: [expectedResult],
        resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result: expectedResult, results: [expectedResult] }],
        cachedAt: 1,
      },
    });
    expect(result.rows).toEqual([
      [1, "", false],
      [2, null, true],
    ]);
    expect(result.mongo_documents[0]).toHaveProperty("omitted", undefined);
    expect(result.session_id).toBe("live-session");
  });
});
