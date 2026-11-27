import { describe, expect, it } from "vitest";
import { oraclePackageMemberSourceRequest, resolveOraclePackageMemberNavigation, type OraclePackageSourceContext } from "@/lib/sql/oraclePackageMemberNavigation";
import { resolveSqlObjectNavigationIdentity } from "@/lib/sql/sqlNavigation";

const SPEC = `CREATE OR REPLACE PACKAGE LLMES.BZ_EM_PRO AS
  PROCEDURE BZ_EM_CLEAN_REC_S(V0 STR_ARY_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2);
  PROCEDURE BZ_EM_CLEAN_REC_E(V0 STR_ARY_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2);
  FUNCTION NEXT_SEQ(P_NAME VARCHAR2) RETURN NUMBER;
END BZ_EM_PRO;`;

const BODY = `CREATE OR REPLACE PACKAGE BODY LLMES.BZ_EM_PRO AS
  PROCEDURE BZ_EM_CLEAN_REC_S(V0 STR_ARY_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
  BEGIN
    BZ_EM_CLEAN_REC_E(V0, IRET, SRET);
  END BZ_EM_CLEAN_REC_S;

  PROCEDURE BZ_EM_CLEAN_REC_E(V0 STR_ARY_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
  BEGIN
    SELECT COUNT(*) INTO IRET FROM BZ_EM_CLEAN_REC_E;
  END BZ_EM_CLEAN_REC_E;
END BZ_EM_PRO;`;

const specContext: OraclePackageSourceContext = { name: "BZ_EM_PRO", schema: "LLMES", objectType: "PACKAGE" };
const bodyContext: OraclePackageSourceContext = { ...specContext, objectType: "PACKAGE_BODY" };

/** `needle` 定位到源码里的那一处，`clickOffset` 是其中被点中的字符。 */
function resolveAt(source: string, context: OraclePackageSourceContext, needle: string, clickOffset = 2) {
  const found = source.indexOf(needle);
  expect(found).toBeGreaterThan(-1);
  const position = found + clickOffset;
  const identity = resolveSqlObjectNavigationIdentity(source, position, "oracle");
  expect(identity).not.toBeNull();
  return resolveOraclePackageMemberNavigation({ source, position, identity: identity!, context });
}

describe("resolveOraclePackageMemberNavigation", () => {
  it("sends a spec declaration to the package body instead of a standalone procedure", () => {
    const resolved = resolveAt(SPEC, specContext, "BZ_EM_CLEAN_REC_E");
    expect(resolved?.kind).toBe("packageBody");
    expect(resolved?.kind === "packageBody" && resolved.target).toEqual({
      name: "BZ_EM_CLEAN_REC_E",
      type: "procedure",
      schema: "LLMES",
      parentName: "BZ_EM_PRO",
      parentSchema: "LLMES",
      signature: "V0 STR_ARY_TYPE, IRET VARCHAR2, SRET VARCHAR2",
    });
  });

  it("keeps the declared return kind for functions", () => {
    const resolved = resolveAt(SPEC, specContext, "NEXT_SEQ");
    expect(resolved?.kind === "packageBody" && resolved.target.type).toBe("function");
  });

  it("jumps inside the body for a call between members", () => {
    const resolved = resolveAt(BODY, bodyContext, "BZ_EM_CLEAN_REC_E(V0, IRET");
    expect(resolved?.kind).toBe("document");
    expect(resolved?.entry.implemented).toBe(true);
    expect(resolved?.entry.line).toBe(7);
  });

  it("resolves a qualified call on the package itself", () => {
    const source = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "BZ_EM_PRO.BZ_EM_CLEAN_REC_E(V0, IRET, SRET);");
    const resolved = resolveAt(source, bodyContext, "BZ_EM_PRO.BZ_EM_CLEAN_REC_E");
    expect(resolved?.kind).toBe("document");
    expect(resolved?.entry.line).toBe(7);
  });

  it("leaves other packages, schemas and three-part names to metadata", () => {
    const source = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "OTHER_PKG.BZ_EM_CLEAN_REC_E(V0, IRET, SRET);");
    expect(resolveAt(source, bodyContext, "OTHER_PKG.BZ_EM_CLEAN_REC_E")).toBeNull();
    const qualified = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "LLMES.BZ_EM_PRO.BZ_EM_CLEAN_REC_E(V0, IRET, SRET);");
    expect(resolveAt(qualified, bodyContext, "LLMES.BZ_EM_PRO.BZ_EM_CLEAN_REC_E")).toBeNull();
  });

  it("does not steal a table that shares a member name", () => {
    expect(resolveAt(BODY, bodyContext, "FROM BZ_EM_CLEAN_REC_E", 7)).toBeNull();
  });

  it("ignores names that the package does not declare", () => {
    expect(resolveAt(BODY, bodyContext, "STR_ARY_TYPE")).toBeNull();
  });

  it("picks the overload whose parameters match the clicked declaration", () => {
    const spec = `CREATE OR REPLACE PACKAGE LLMES.BZ_EM_PRO AS
  PROCEDURE LOG_EVENT(P_TEXT VARCHAR2);
  PROCEDURE LOG_EVENT(P_CODE NUMBER, P_TEXT VARCHAR2);
END BZ_EM_PRO;`;
    const resolved = resolveAt(spec, specContext, "LOG_EVENT(P_CODE");
    expect(resolved?.kind === "packageBody" && resolved.target.signature).toBe("P_CODE NUMBER, P_TEXT VARCHAR2");
  });
});

describe("oraclePackageMemberSourceRequest", () => {
  it("fetches the package body and keeps the member only as a cursor target", () => {
    const resolved = resolveAt(SPEC, specContext, "BZ_EM_CLEAN_REC_E");
    expect(resolved?.kind).toBe("packageBody");
    expect(oraclePackageMemberSourceRequest(resolved!.kind === "packageBody" ? resolved.target : { name: "" })).toEqual({
      name: "BZ_EM_PRO",
      objectType: "PACKAGE_BODY",
      schema: "LLMES",
      focusMember: { name: "BZ_EM_CLEAN_REC_E", kind: "procedure", signature: "V0 STR_ARY_TYPE, IRET VARCHAR2, SRET VARCHAR2" },
    });
  });

  it("uppercases unquoted identities and falls back to the session schema", () => {
    expect(oraclePackageMemberSourceRequest({ name: "load_feeds", type: "function", parentName: "sales_pkg" }, "scott")).toEqual({
      name: "SALES_PKG",
      objectType: "PACKAGE_BODY",
      schema: "scott",
      focusMember: { name: "LOAD_FEEDS", kind: "function" },
    });
  });

  it("keeps quoted mixed-case identities as written", () => {
    expect(oraclePackageMemberSourceRequest({ name: "MiXeD", nameQuoted: true, type: "procedure", parentName: "PkG", parentNameQuoted: true, parentSchema: "ScOtT", parentSchemaQuoted: true })?.name).toBe("PkG");
  });

  it("ignores targets that are not package members", () => {
    expect(oraclePackageMemberSourceRequest({ name: "STANDALONE", type: "procedure" })).toBeNull();
    expect(oraclePackageMemberSourceRequest({ name: "SOME_PKG", type: "package" })).toBeNull();
  });
});
