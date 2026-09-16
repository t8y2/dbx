import { describe, expect, it } from "vitest";
import { binaryCellBytesToHexValue, canImportBinaryCellFile } from "@/lib/dataGrid/binaryCellDownload";

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
  });
});
