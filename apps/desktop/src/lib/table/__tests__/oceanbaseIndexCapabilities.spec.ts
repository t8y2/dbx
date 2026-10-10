import { describe, expect, it } from "vitest";
import { oceanbaseIndexCapabilities, oceanbasePhysicalIndexColumns, quoteOceanbaseIndexColumn } from "../oceanbaseIndexCapabilities";

describe("OceanBase Oracle index capabilities", () => {
  it.each(["4.2.5", "4.2.5.7", "V4.2.5.7", "4.2.5-CE"])("offers only documented types for %s", (version) => {
    expect(oceanbaseIndexCapabilities(version)).toEqual({ types: ["NORMAL", "FUNCTION-BASED NORMAL"], status: "documented" });
  });
  it.each([undefined, null, "", " "])("keeps missing version distinct", (version) => {
    expect(oceanbaseIndexCapabilities(version)).toEqual({ types: ["NORMAL"], status: "unavailable" });
  });
  it.each(["4.2.50", "4.3.5.1", "unknown"])("does not infer support for %s", (version) => {
    expect(oceanbaseIndexCapabilities(version)).toEqual({ types: ["NORMAL"], status: "unverified" });
  });
  it("preserves quoted names and order across a type switch", () => {
    const names = ['Mixed"Column', "Second"];
    const terms = names.map(quoteOceanbaseIndexColumn);
    expect(terms).toEqual(['"Mixed""Column"', '"Second"']);
    expect(oceanbasePhysicalIndexColumns(terms, names)).toEqual(names);
  });
  it("does not silently turn an expression into a physical column", () => {
    expect(oceanbasePhysicalIndexColumns(['LOWER("Name")'], ["Name"])).toBeUndefined();
    expect(oceanbasePhysicalIndexColumns(['"name"'], ["Name"])).toBeUndefined();
    expect(oceanbasePhysicalIndexColumns([], ["Name"])).toEqual([]);
  });
});
