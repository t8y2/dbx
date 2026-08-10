import { describe, expect, it } from "vitest";
import { DOLT_SQL_ROUTINES, doltSqlBuiltinTerms, doltSqlRoutineSignatures, isDoltDriverProfile } from "@/lib/database/doltProfile";

describe("doltProfile", () => {
  it("matches only the dedicated Dolt driver profile", () => {
    expect(isDoltDriverProfile("dolt")).toBe(true);
    expect(isDoltDriverProfile("DOLT")).toBe(true);
    expect(isDoltDriverProfile("mysql")).toBe(false);
    expect(isDoltDriverProfile()).toBe(false);
  });

  it("exposes Dolt routines only for Dolt connections", () => {
    expect(doltSqlBuiltinTerms("mysql")).toBe("");
    expect(doltSqlRoutineSignatures("mysql").size).toBe(0);

    const terms = new Set(doltSqlBuiltinTerms("dolt").split(" "));
    const signatures = doltSqlRoutineSignatures("dolt");
    expect(terms.has("active_branch")).toBe(true);
    expect(terms.has("dolt_branch")).toBe(true);
    expect(terms.has("dolt_version")).toBe(true);
    expect(signatures.get("DOLT_MERGE_BASE")).toEqual(["revision_a", "revision_b"]);
    expect(signatures.size).toBe(DOLT_SQL_ROUTINES.length);
  });
});
