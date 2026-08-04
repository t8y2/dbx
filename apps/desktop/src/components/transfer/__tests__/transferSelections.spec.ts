import { describe, expect, it } from "vitest";
import { buildTransferObjectSelections } from "../transferSelections";

function setOf(names: string[]): Set<string> {
  return new Set(names);
}

describe("buildTransferObjectSelections", () => {
  it("serializes non-table selections in request order", () => {
    const result = buildTransferObjectSelections(
      {
        VIEW: setOf(["v1", "v2"]),
        SEQUENCE: setOf(["s1"]),
        TABLE: setOf(["t1"]),
      },
      [],
    );
    expect(result).toEqual([
      { objectType: "VIEW", names: ["v1", "v2"] },
      { objectType: "SEQUENCE", names: ["s1"] },
    ]);
  });

  it("drops TABLE selections (handled by the tables field)", () => {
    const result = buildTransferObjectSelections({ TABLE: setOf(["t1", "t2"]) }, []);
    expect(result).toEqual([]);
  });

  it("filters disabled object types even when stale selections remain", () => {
    const result = buildTransferObjectSelections(
      {
        VIEW: setOf(["v1"]),
        SEQUENCE: setOf(["s1"]),
        PROCEDURE: setOf(["p1"]),
      },
      ["VIEW", "SEQUENCE"],
    );
    expect(result).toEqual([{ objectType: "PROCEDURE", names: ["p1"] }]);
  });

  it("returns an empty payload when nothing is selected", () => {
    expect(buildTransferObjectSelections({}, [])).toEqual([]);
  });
});
