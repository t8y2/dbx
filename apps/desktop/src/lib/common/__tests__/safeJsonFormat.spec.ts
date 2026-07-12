import { describe, it, expect } from "vitest";
import { isLosslessJsonNumber, parseJsonPreservingLargeNumbers, safeJsonFormat } from "../safeJsonFormat";

describe("safeJsonFormat", () => {
  it("preserves large integers exceeding MAX_SAFE_INTEGER", () => {
    const input = '{"id":87712409002717401}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": 87712409002717401\n}');
  });

  it("preserves negative large integers exceeding MIN_SAFE_INTEGER", () => {
    const input = '{"value":-87712409002717401}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "value": -87712409002717401\n}');
  });

  it("preserves multiple large integers in the same JSON", () => {
    const input = '{"a":87712409002717401,"b":9007199254740992}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "a": 87712409002717401,\n  "b": 9007199254740992\n}');
  });

  it("does not modify integers within MAX_SAFE_INTEGER", () => {
    const input = '{"id":12345}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": 12345\n}');
  });

  it("does not modify integers exactly at MAX_SAFE_INTEGER", () => {
    const input = `{"id":${Number.MAX_SAFE_INTEGER}}`;
    const result = safeJsonFormat(input, 2);
    expect(result).toBe(`{\n  "id": ${Number.MAX_SAFE_INTEGER}\n}`);
  });

  it("preserves floating point numbers with large integer parts", () => {
    const input = '{"value":87712409002717401.5}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "value": 87712409002717401.5\n}');
  });

  it("compacts JSON without indent", () => {
    const input = '{\n  "id":  87712409002717401\n}';
    const result = safeJsonFormat(input);
    expect(result).toBe('{"id":87712409002717401}');
  });

  it("preserves large integers in nested JSON", () => {
    const input = '{"data":{"id":87712409002717401}}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "data": {\n    "id": 87712409002717401\n  }\n}');
  });

  it("preserves large integers in arrays", () => {
    const input = '{"ids":[87712409002717401,87712409002717402]}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "ids": [\n    87712409002717401,\n    87712409002717402\n  ]\n}');
  });

  it("handles string values that look like numbers", () => {
    const input = '{"id":"87712409002717401"}';
    const result = safeJsonFormat(input, 2);
    expect(result).toBe('{\n  "id": "87712409002717401"\n}');
  });

  it("does not replace large digit sequences inside strings", () => {
    const input = '{"text":"value 87712409002717401, unchanged"}';
    expect(safeJsonFormat(input, 2)).toBe('{\n  "text": "value 87712409002717401, unchanged"\n}');
  });

  it("parses large integers as lossless numeric values", () => {
    const parsed = parseJsonPreservingLargeNumbers('{"companyId":518400931654815740,"safe":42}') as Record<string, unknown>;
    expect(isLosslessJsonNumber(parsed.companyId)).toBe(true);
    expect(isLosslessJsonNumber(parsed.companyId) ? parsed.companyId.raw : null).toBe("518400931654815740");
    expect(parsed.safe).toBe(42);
  });

  it("preserves fractional and exponent literals that Number would round or overflow", () => {
    const input = '{"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20,"overflow":1e999}';
    const parsed = parseJsonPreservingLargeNumbers(input) as Record<string, unknown>;

    expect(isLosslessJsonNumber(parsed.fraction) ? parsed.fraction.raw : null).toBe("0.123456789012345678901234");
    expect(isLosslessJsonNumber(parsed.scientific) ? parsed.scientific.raw : null).toBe("1.234567890123456789e20");
    expect(isLosslessJsonNumber(parsed.overflow) ? parsed.overflow.raw : null).toBe("1e999");
    expect(safeJsonFormat(input, 2)).toContain("0.123456789012345678901234");
    expect(safeJsonFormat(input, 2)).toContain("1.234567890123456789e20");
    expect(safeJsonFormat(input, 2)).toContain("1e999");
  });
});
