import { describe, expect, it } from "vitest";
import { oraclePackageCatalogSource, rewriteOraclePackageSource } from "@/lib/table/oraclePackageSource";

describe("Oracle package Save As source rewrite", () => {
  it("preserves a differently cased quoted package reference in a copied body", () => {
    const source = 'PACKAGE BODY "p_old" AS BEGIN P_OLD.RUN; "p_old".RUN; END "p_old";';
    expect(rewriteOraclePackageSource(source, { owner: "APP", oldName: "p_old", newName: "P_NEW", body: true })).toContain('P_OLD.RUN; "P_NEW".RUN;');
  });
  it("adds CREATE and changes the package declaration, outer END and self-qualified member references", () => {
    const source = ["PACKAGE APP.P_OLD AS", "  PROCEDURE RUN;", "END P_OLD;"].join("\r\n");
    expect(rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: false })).toBe('CREATE PACKAGE APP."P_NEW" AS\r\n  PROCEDURE RUN;\r\nEND "P_NEW";');
  });

  it("rejects SQL before the package declaration and CREATE OR REPLACE drafts", () => {
    expect(() => rewriteOraclePackageSource("DROP TABLE OTHER; PACKAGE OLD AS PROCEDURE P; END OLD;", { owner: "APP", oldName: "OLD", newName: "NEW", body: false })).toThrow();
    expect(() => rewriteOraclePackageSource("CREATE OR REPLACE PACKAGE OLD AS PROCEDURE P; END OLD;", { owner: "APP", oldName: "OLD", newName: "NEW", body: false })).toThrow();
  });

  it("rewrites a body self-reference but preserves comments, literals, nested END names and other owners", () => {
    const source = ["PACKAGE BODY P_OLD AS", "  PROCEDURE RUN IS", "    v VARCHAR2(20) := 'P_OLD.RUN'; -- P_OLD.RUN", "  BEGIN", "    P_OLD.RUN; OTHER.P_OLD.RUN;", "  END RUN;", "END P_OLD;"].join("\n");
    expect(rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toBe('CREATE PACKAGE BODY "P_NEW" AS\n  PROCEDURE RUN IS\n    v VARCHAR2(20) := \'P_OLD.RUN\'; -- P_OLD.RUN\n  BEGIN\n    "P_NEW".RUN; OTHER.P_OLD.RUN;\n  END RUN;\nEND "P_NEW";');
  });

  it("preserves a string literal equal to the package name", () => {
    const source = "PACKAGE BODY P_OLD AS v VARCHAR2(20) := 'P_OLD'; BEGIN NULL; END P_OLD;";
    expect(rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toContain("'P_OLD'");
  });

  it("rejects a variable dynamic SQL reference that cannot be retargeted", () => {
    const source = `PACKAGE BODY P_OLD AS
      PROCEDURE RUN IS
        s VARCHAR2(100) := 'BEGIN P_OLD.RUN; END;';
      BEGIN
        EXECUTE IMMEDIATE s;
      END RUN;
    END P_OLD;`;
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toThrow();
  });

  it.each([
    ["concatenated expression", "EXECUTE IMMEDIATE 'BEGIN P_OLD.RUN; END;' || suffix;"],
    ["quoted q-literal reference", "EXECUTE IMMEDIATE q'!BEGIN \"P_OLD\".RUN; END;!';"],
  ])("rejects %s dynamic SQL that needs manual correction", (_label, statement) => {
    const source = `PACKAGE BODY P_OLD AS PROCEDURE RUN IS suffix VARCHAR2(10); BEGIN ${statement} END RUN; END P_OLD;`;
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toThrow();
  });

  it("accepts a complete q-literal with no old package reference", () => {
    const source = "PACKAGE BODY P_OLD AS PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE q'!BEGIN NULL; END;!'; END RUN; END P_OLD;";
    expect(rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toContain("q'!BEGIN NULL; END;!'");
  });

  it("rejects nested dynamic SQL hidden inside a complete string literal", () => {
    const source = "PACKAGE BODY P_OLD AS PROCEDURE RUN IS BEGIN EXECUTE IMMEDIATE 'BEGIN EXECUTE IMMEDIATE ''BEGIN P_OLD.RUN; END;''; END;'; END RUN; END P_OLD;";
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: true })).toThrow(/dynamic/i);
  });

  it("preserves an unnamed outer END", () => {
    expect(rewriteOraclePackageSource("PACKAGE P_OLD AS PROCEDURE RUN; END;", { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: false })).toBe('CREATE PACKAGE "P_NEW" AS PROCEDURE RUN; END;');
  });

  it("rejects a package name that would capture a local record in the copied body", () => {
    const source = "PACKAGE BODY P_OLD AS NEW_P RECORD; BEGIN RETURN P_OLD.VALUE; END P_OLD;";
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "NEW_P", body: true })).toThrow("could capture a reference");
  });

  it("rejects a new package name declared in a later package-body member", () => {
    const source = `PACKAGE BODY OLD_P AS
      PROCEDURE helper IS BEGIN NULL; END helper;
      FUNCTION value RETURN NUMBER IS
        TYPE rec IS RECORD (x NUMBER);
        NEW_P rec;
      BEGIN
        NEW_P.x := 2;
        RETURN OLD_P.x;
      END value;
    END OLD_P;`;
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "OLD_P", newName: "NEW_P", body: true })).toThrow("could capture a reference");
  });

  it("rejects a new package name declared inside a nested anonymous block", () => {
    const source = `PACKAGE BODY OLD_P AS
      FUNCTION value RETURN NUMBER IS
      BEGIN
        DECLARE
          TYPE rec IS RECORD (x NUMBER);
          NEW_P rec;
        BEGIN
          NEW_P.x := 2;
          RETURN OLD_P.x;
        END;
      END value;
    END OLD_P;`;
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "OLD_P", newName: "NEW_P", body: true })).toThrow("could capture a reference");
  });

  it("rejects a new package name used as a later member parameter", () => {
    const source = `PACKAGE BODY OLD_P AS
      PROCEDURE helper IS BEGIN NULL; END helper;
      FUNCTION f(NEW_P rec) RETURN NUMBER IS
      BEGIN
        RETURN OLD_P.x;
      END f;
    END OLD_P;`;
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "OLD_P", newName: "NEW_P", body: true })).toThrow("parameter NEW_P");
  });

  it("normalizes the optional final statement terminator from catalog source", () => {
    expect(oraclePackageCatalogSource('CREATE PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW";')).toBe('PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW"');
    expect(oraclePackageCatalogSource('PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW";')).toBe('PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW"');
    expect(oraclePackageCatalogSource('PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW"')).toBe('PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW"');
  });

  it("adds a missing catalog terminator before rewriting the package source", () => {
    expect(rewriteOraclePackageSource("PACKAGE P_OLD AS PROCEDURE RUN; END P_OLD", { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body: false })).toBe('CREATE PACKAGE "P_NEW" AS PROCEDURE RUN; END "P_NEW";');
  });

  it.each([
    ["wrong object type", "PACKAGE BODY P_OLD AS END P_OLD;", false],
    ["wrong declaration", "PACKAGE P_OTHER AS END P_OTHER;", false],
    ["unqualified occurrence", "PACKAGE P_OLD AS PROCEDURE RUN IS BEGIN P_OLD := 1; END RUN; END P_OLD;", false],
    ["dynamic self reference", "PACKAGE BODY P_OLD AS BEGIN EXECUTE IMMEDIATE 'SELECT P_OLD.RUN FROM DUAL'; END P_OLD;", true],
  ])("rejects %s before producing replacement source", (_label, source, body) => {
    expect(() => rewriteOraclePackageSource(source, { owner: "APP", oldName: "P_OLD", newName: "P_NEW", body })).toThrow();
  });
});
