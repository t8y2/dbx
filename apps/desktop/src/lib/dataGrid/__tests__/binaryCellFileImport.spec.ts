import { describe, expect, it } from "vitest";
import {
  binaryCellBytesToHexValue,
  binaryCellClipboardText,
  binaryCellDisplayText,
  binaryCellDownloadPayload,
  canImportBinaryCellFile,
  hasUnsafeOpaqueAggregateStatePredicate,
  isBinaryCellColumnType,
  isOpaqueAggregateStateColumnType,
  mergeOpaqueReadonlyColumnIndexes,
} from "@/lib/dataGrid/binaryCellDownload";

describe("binary cell file import", () => {
  it("encodes arbitrary and empty files as prefixed hex cell values", () => {
    expect(binaryCellBytesToHexValue(new Uint8Array([0x00, 0x01, 0xab, 0xff]))).toBe("0x0001abff");
    expect(binaryCellBytesToHexValue(new Uint8Array())).toBe("0x");
  });

  it("offers file import only where prefixed hex values have binary save syntax", () => {
    expect(canImportBinaryCellFile("postgres", "bytea")).toBe(true);
    expect(canImportBinaryCellFile("mysql", "longblob")).toBe(true);
    expect(canImportBinaryCellFile("mysql", "varbinary(255)")).toBe(true);
    expect(canImportBinaryCellFile("postgres", "text")).toBe(false);
    expect(canImportBinaryCellFile("sqlserver", "varbinary(max)")).toBe(false);
    expect(canImportBinaryCellFile("sqlite", "blob")).toBe(false);
    expect(canImportBinaryCellFile("mysql", "agg_state<group_concat(text)>")).toBe(false);
  });

  it("presents aggregate states as opaque byte-preserving binary values", () => {
    const type = "agg_state<group_concat(text)>";
    const value = "0x0001abff";
    expect(isOpaqueAggregateStateColumnType(type)).toBe(true);
    expect(isOpaqueAggregateStateColumnType(" AGG_STATE < sum(int) > ")).toBe(true);
    expect(isOpaqueAggregateStateColumnType("agg_state<")).toBe(false);
    expect(isOpaqueAggregateStateColumnType("agg_state<>")).toBe(false);
    expect(isOpaqueAggregateStateColumnType("😺agg_state<sum(int)>")).toBe(false);
    expect(isBinaryCellColumnType(type)).toBe(true);
    expect(binaryCellDisplayText(value, type, undefined, "mysql")).toBe("AGG_STATE [4 bytes]");
    expect(binaryCellClipboardText(value, type, "mysql")).toBeNull();
    expect(binaryCellDownloadPayload(value, "binary", type, "mysql").data).toEqual(new Uint8Array([0x00, 0x01, 0xab, 0xff]));
  });

  it("merges opaque columns into the centralized readonly indexes", () => {
    const readonly = mergeOpaqueReadonlyColumnIndexes([0, 3], ["varchar", "agg_state<sum(int)>", "varbinary", "text"]);
    expect([...readonly!]).toEqual([0, 3, 1]);
    expect(mergeOpaqueReadonlyColumnIndexes(undefined, ["varchar", "varbinary"])).toBeUndefined();
  });

  it("only blocks keyless predicates for non-null or missing opaque values", () => {
    const types = ["varchar", "agg_state<sum(int)>"];
    expect(hasUnsafeOpaqueAggregateStatePredicate(types, ["Ada", null])).toBe(false);
    expect(hasUnsafeOpaqueAggregateStatePredicate(types, ["Ada", "0x00ff"])).toBe(true);
    expect(hasUnsafeOpaqueAggregateStatePredicate(types, ["Ada"])).toBe(true);
    expect(hasUnsafeOpaqueAggregateStatePredicate(["varchar", "text"], ["Ada", "ordinary"])).toBe(false);
  });
});
