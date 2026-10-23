import { describe, expect, it } from "vitest";
import { schemaDiffRoutineObjectTypes, schemaDiffRoutineObjectTypesIntersection, supportsSchemaDiffRoutines } from "@/lib/database/databaseObjectCapabilities";

describe("Oracle-family routine comparison workflow", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("offers standalone procedures and functions for a %s pair", (databaseType) => {
    expect(supportsSchemaDiffRoutines(databaseType)).toBe(true);
    expect(schemaDiffRoutineObjectTypes(databaseType)).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypesIntersection(databaseType, databaseType)).toEqual(["PROCEDURE", "FUNCTION"]);
  });
});
