import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readLargeValueChunk: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
import { materializeLargeValueSnapshot, materializeSnapshotResultRows, readLargeValueSnapshot } from "@/lib/dataGrid/largeValueSnapshot";

const request = { connectionId: "ob", database: "APP", clientSessionId: "tab-original", valueRef: "original-ref" };
const response = (data: string, next_offset: number, eof = false) => ({ status: "ok", data, next_offset, eof, value_kind: "text" });
beforeEach(() => mocks.readLargeValueChunk.mockReset());

describe("original-result LOB snapshot consumption", () => {
  it("preserves every binary byte and prefixes the assembled value exactly once", async () => {
    const hex = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
    mocks.readLargeValueChunk.mockResolvedValueOnce({ ...response(hex.slice(0, 200), 100), value_kind: "binary" }).mockResolvedValueOnce({ ...response(hex.slice(200), 256, true), value_kind: "binary" });
    expect(await materializeLargeValueSnapshot(request, () => true)).toBe("0x" + hex);
  });

  it("distinguishes an empty BLOB from a zero byte and rejects malformed or incomplete hex", async () => {
    mocks.readLargeValueChunk.mockResolvedValueOnce({ ...response("", 0, true), value_kind: "binary" });
    expect(await materializeLargeValueSnapshot(request, () => true)).toBe("0x");
    mocks.readLargeValueChunk.mockResolvedValueOnce({ ...response("00", 1, true), value_kind: "binary" });
    expect(await materializeLargeValueSnapshot(request, () => true)).toBe("0x00");
    mocks.readLargeValueChunk.mockResolvedValueOnce({ ...response("0", 1, true), value_kind: "binary" });
    await expect(materializeLargeValueSnapshot(request, () => true)).rejects.toThrow("binary encoding");
  });
  it.each([{ eof: "false" }, { value_kind: "unknown" }, { data: null }])("rejects malformed payload fields before consuming a chunk: %j", async (invalid) => {
    mocks.readLargeValueChunk.mockResolvedValue({ ...response("text", 4, true), ...invalid });
    const consume = vi.fn();
    await expect(readLargeValueSnapshot(request, () => true, consume)).rejects.toThrow("Invalid LOB chunk payload");
    expect(consume).not.toHaveBeenCalled();
  });
  it("uses server character offsets and preserves Chinese and emoji across chunks", async () => {
    mocks.readLargeValueChunk.mockResolvedValueOnce(response("中文😀", 3)).mockResolvedValueOnce(response("末尾😀", 6, true));
    expect(await materializeLargeValueSnapshot(request, () => true)).toBe("中文😀末尾😀");
    expect(mocks.readLargeValueChunk.mock.calls.map(([args]) => args.offset)).toEqual([0, 3]);
    expect(mocks.readLargeValueChunk.mock.calls[1]?.[0]).toMatchObject({ valueRef: "original-ref", clientSessionId: "tab-original" });
  });

  it("refuses an expired original locator without returning a preview or re-querying a row", async () => {
    mocks.readLargeValueChunk.mockResolvedValue({ ...response("", 0), status: "expired" });
    await expect(materializeLargeValueSnapshot(request, () => true)).rejects.toThrow("expired");
    expect(mocks.readLargeValueChunk).toHaveBeenCalledTimes(1);
  });

  it("rejects changed context after await before any consumer sees the value", async () => {
    let current = true;
    mocks.readLargeValueChunk.mockImplementation(async () => {
      current = false;
      return response("wrong context", 1, true);
    });
    const consume = vi.fn();
    await expect(readLargeValueSnapshot(request, () => current, consume)).rejects.toThrow("context changed");
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects non-progressing chunks instead of looping or copying partial data", async () => {
    mocks.readLargeValueChunk.mockResolvedValue(response("prefix", 0));
    await expect(materializeLargeValueSnapshot(request, () => true)).rejects.toThrow("offset");
    expect(mocks.readLargeValueChunk).toHaveBeenCalledTimes(1);
  });

  it("rejects expiry between chunks without returning the already fetched prefix", async () => {
    mocks.readLargeValueChunk.mockResolvedValueOnce(response("前缀😀", 3)).mockResolvedValueOnce({ ...response("", 3), status: "expired" });
    await expect(materializeLargeValueSnapshot(request, () => true)).rejects.toThrow("expired");
    expect(mocks.readLargeValueChunk).toHaveBeenCalledTimes(2);
  });

  it("validates character offsets rather than UTF-16 length", async () => {
    mocks.readLargeValueChunk.mockResolvedValue(response("😀", 2, true));
    await expect(materializeLargeValueSnapshot(request, () => true)).rejects.toThrow("character count");
  });

  it("uses each export result's original connection and column identity and leaves previews untouched", async () => {
    const result = {
      columns: ["Payload", "PAYLOAD"],
      column_types: ["CLOB", "CLOB"],
      rows: [["a-preview", "b-preview"]],
      affected_rows: 0,
      execution_time_ms: 0,
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 0, value_ref: "uppercase-column-ref" }],
      large_value_context: { connectionId: "other-ob", database: "OTHER", txnSessionId: "original-transaction" },
    };
    mocks.readLargeValueChunk.mockResolvedValue(response("完整😀", 3, true));
    expect(await materializeSnapshotResultRows(result, () => true)).toEqual([["a-preview", "完整😀"]]);
    expect(result.rows).toEqual([["a-preview", "b-preview"]]);
    expect(mocks.readLargeValueChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "other-ob",
        database: "OTHER",
        txnSessionId: "original-transaction",
        valueRef: "uppercase-column-ref",
      }),
    );
  });
});
