import { describe, expect, it } from "vitest";
import { parseJsonPreservingLargeNumbers, safeJsonFormat, stringifyJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";

describe("safeJsonFormat", () => {
  it("keeps every preserved number spelling, including placeholders whose indexes share a prefix", () => {
    const numbers = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? `12345678901234567${String(index).padStart(3, "0")}` : `${index}.50`));
    const text = `{"values":[${numbers.join(",")}],"label":"__DBX_LOSSLESS_NUMBER_1__"}`;

    const formatted = safeJsonFormat(text, 2);

    for (const raw of numbers) expect(formatted).toContain(` ${raw}`);
    expect(formatted).toContain('"label": "__DBX_LOSSLESS_NUMBER_1__"');
    expect(JSON.parse(safeJsonFormat(text)).label).toBe("__DBX_LOSSLESS_NUMBER_1__");
  });

  it("round-trips preserved numbers through parse and stringify", () => {
    const text = '{"a":1.0,"b":[9007199254740993,-0,2.5e+30],"c":"x"}';
    expect(stringifyJsonPreservingLargeNumbers(parseJsonPreservingLargeNumbers(text))).toBe(text);
  });

  it("surfaces invalid JSON as a SyntaxError", () => {
    expect(() => safeJsonFormat('{"a": 1.5,}')).toThrow(SyntaxError);
  });

  it("formats a large document with many decimals in linear time", () => {
    const text = JSON.stringify(Array.from({ length: 20000 }, (_, index) => ({ id: index, ratio: index * 1.5, name: `item ${index}` })));

    const started = performance.now();
    const formatted = safeJsonFormat(text, 2);
    const elapsed = performance.now() - started;

    expect(formatted).toContain('"ratio": 29998.5');
    // Restoring the placeholders one by one rescanned the whole output per number and needed minutes here.
    expect(elapsed).toBeLessThan(3000);
  });
});
