import { describe, expect, it } from "vitest";
import { oracleDependencyProvider, oracleObjectDependenciesSql } from "@/lib/database/oracleObjectDependencies";

const node = (overrides: Record<string, unknown> = {}) => ({ type: "procedure" as const, schema: "APP", objectName: "RUN_JOB", label: "RUN_JOB", ...overrides });

describe("Oracle object dependencies", () => {
  it("queries both direct directions and preserves raw dictionary details", () => {
    const sql = oracleDependencyProvider.buildQuery(node());
    expect(sql).toContain("'DEPENDS_ON' AS DIRECTION");
    expect(sql).toContain("'REFERENCED_BY' AS DIRECTION");
    expect(sql).toContain("d.TYPE = 'PROCEDURE'");
    expect(sql).toContain("d.REFERENCED_TYPE = 'PROCEDURE'");
    for (const column of ["OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("FROM ALL_DEPENDENCIES d");
    expect(sql).not.toContain("DBA_DEPENDENCIES");
    expect(sql).not.toContain("Package/body scope");
  });

  it("matches local reverse references without hiding remote outbound dependencies", () => {
    const sql = oracleDependencyProvider.buildQuery(node())!;
    const [dependsOn, referencedBy] = sql.split("UNION ALL");
    expect(dependsOn).not.toContain("REFERENCED_LINK_NAME IS NULL");
    expect(dependsOn).toContain("d.REFERENCED_LINK_NAME");
    expect(referencedBy).toContain("d.REFERENCED_LINK_NAME IS NULL");
  });

  it("uses the owning package scope for members and exposes it in the title", () => {
    const member = node({ type: "function", objectName: "CALC", parentType: "package", parentName: "PAYROLL", parentSchema: "HR" });
    expect(oracleDependencyProvider.targetLabel?.(member)).toEqual({ name: "HR.PAYROLL", packageScope: true });
    const sql = oracleDependencyProvider.buildQuery(member)!;
    expect(sql).toContain("'PAYROLL' AS TARGET_NAME");
    expect(sql).toContain("d.TYPE IN ('PACKAGE', 'PACKAGE BODY')");
    expect(sql).not.toContain("'CALC' AS TARGET_NAME");
    expect(sql).toContain("Package/body scope, not member-level dependencies");
  });

  it("keeps package and body types distinct in package-scoped results", () => {
    const sql = oracleObjectDependenciesSql({ schema: "HR", objectName: "PAYROLL", objectType: "PACKAGE" });
    expect(sql).toContain("d.TYPE IN ('PACKAGE', 'PACKAGE BODY')");
    expect(sql).toContain("d.REFERENCED_TYPE IN ('PACKAGE', 'PACKAGE BODY')");
    expect(sql).toContain("d.TYPE AS OBJECT_TYPE");
  });

  it("escapes literals and rejects incomplete or unsupported tree nodes", () => {
    expect(oracleObjectDependenciesSql({ schema: "O'BRIEN", objectName: "R'UN", objectType: "FUNCTION" })).toContain("'O''BRIEN'");
    expect(oracleDependencyProvider.buildQuery(node({ schema: undefined }))).toBeNull();
    expect(oracleDependencyProvider.supports(node({ type: "procedure", parentType: "package", parentName: "PKG" }))).toBe(false);
    expect(oracleDependencyProvider.supports(node({ type: "procedure", parentType: "package", parentName: "PKG", parentSchema: undefined }))).toBe(false);
    expect(oracleDependencyProvider.supports(node({ type: "trigger" }))).toBe(false);
  });
});
