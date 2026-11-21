import { describe, expect, it } from "vitest";
import { schemaDiffRoutineObjectTypes, schemaDiffRoutineObjectTypesIntersection, supportsSchemaDiffRoutines } from "@/lib/database/databaseObjectCapabilities";

describe("Oracle-family routine comparison workflow", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("offers standalone procedures and functions for a %s pair", (databaseType) => {
    expect(supportsSchemaDiffRoutines(databaseType)).toBe(true);
    expect(schemaDiffRoutineObjectTypes(databaseType)).toEqual(["PROCEDURE", "FUNCTION"]);
    expect(schemaDiffRoutineObjectTypesIntersection(databaseType, databaseType)).toEqual(["PROCEDURE", "FUNCTION"]);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("only adds explicitly requested package kinds for %s", (databaseType) => {
    expect(schemaDiffRoutineObjectTypes(databaseType, ["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"])).toEqual(["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"]);
    expect(schemaDiffRoutineObjectTypesIntersection(databaseType, databaseType, ["PACKAGE_BODY"])).toEqual(["PACKAGE_BODY"]);
  });

  it.each([
    ["oracle", "oceanbase-oracle"],
    ["oceanbase-oracle", "oracle"],
  ] as const)("permits exact package comparison from %s to %s without broadening standalone conversion", (source, target) => {
    expect(schemaDiffRoutineObjectTypesIntersection(source, target)).toEqual([]);
    expect(schemaDiffRoutineObjectTypesIntersection(source, target, ["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"])).toEqual(["PACKAGE", "PACKAGE_BODY"]);
  });

  it.each(["dameng", "xugu", "mysql", "postgres"] as const)("does not inherit package comparison from the %s sidebar", (databaseType) => {
    expect(schemaDiffRoutineObjectTypes(databaseType, ["PACKAGE", "PACKAGE_BODY"])).toEqual([]);
    expect(schemaDiffRoutineObjectTypesIntersection("oracle", databaseType, ["PACKAGE", "PACKAGE_BODY"])).toEqual([]);
  });
});
