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

  /**
   * 调用点没有签名可用。同名重载有多个实现时必须交回元数据解析链，而不是挑「第一个实现」——
   * 那会让 Ctrl/Cmd+点击悄悄跳到错误的重载。
   */
  describe("overloaded call sites", () => {
    const OVERLOADS = `CREATE OR REPLACE PACKAGE BODY LLMES.BZ_EM_PRO AS
  PROCEDURE LOG_EVENT(P_TEXT VARCHAR2) IS
  BEGIN
    NULL;
  END LOG_EVENT;

  PROCEDURE LOG_EVENT(P_CODE NUMBER, P_TEXT VARCHAR2) IS
  BEGIN
    NULL;
  END LOG_EVENT;

  PROCEDURE PING IS
  BEGIN
    NULL;
  END PING;

  PROCEDURE PING(P_CODE NUMBER) IS
  BEGIN
    NULL;
  END PING;

  PROCEDURE SOLO(P_CODE NUMBER) IS
  BEGIN
    NULL;
  END SOLO;

  PROCEDURE RUN IS
  BEGIN
    LOG_EVENT('hi');
    PING(1);
    SOLO(1);
  END RUN;
END BZ_EM_PRO;`;

    it("refuses an ambiguous overload instead of jumping to the first implementation", () => {
      expect(resolveAt(OVERLOADS, bodyContext, "LOG_EVENT('hi')")).toBeNull();
    });

    it("refuses when one of the overloads takes no parameters", () => {
      // PING / PING(P_CODE) cannot be told apart from the call text alone, and a
      // no-argument header yields no signature to match on either.
      expect(resolveAt(OVERLOADS, bodyContext, "PING(1)")).toBeNull();
    });

    it("still resolves a call whose name has exactly one implementation", () => {
      const resolved = resolveAt(OVERLOADS, bodyContext, "SOLO(1)");
      expect(resolved?.kind).toBe("document");
      expect(resolved?.entry.implemented).toBe(true);
      expect(resolved?.entry.line).toBe(22);
    });
  });

  /** Oracle 下引号标识符大小写敏感：`"MixedCase"` 和 `"MIXEDCASE"` 是两个不同的名字。 */
  describe("quoted identifiers", () => {
    const QUOTED = `CREATE OR REPLACE PACKAGE BODY LLMES.BZ_EM_PRO AS
  PROCEDURE "MixedCase"(P_TEXT VARCHAR2) IS
  BEGIN
    NULL;
  END "MixedCase";

  PROCEDURE RUN IS
  BEGIN
    "MixedCase"('hi');
    "MIXEDCASE"('hi');
  END RUN;
END BZ_EM_PRO;`;

    it("resolves a quoted call that matches the member case exactly", () => {
      const resolved = resolveAt(QUOTED, bodyContext, `"MixedCase"('hi')`);
      expect(resolved?.kind).toBe("document");
      expect(resolved?.entry.name).toBe("MixedCase");
    });

    it("does not bind a quoted call to a member that differs only in case", () => {
      expect(resolveAt(QUOTED, bodyContext, `"MIXEDCASE"('hi')`)).toBeNull();
    });

    it("does not bind an unquoted call to a quoted mixed-case member", () => {
      // 不带引号的 MixedCase 在 Oracle 里就是 MIXEDCASE，不是带引号创建的 "MixedCase"。
      const source = QUOTED.replace(`"MIXEDCASE"('hi');`, "MixedCase('hi');");
      expect(resolveAt(source, bodyContext, "MixedCase('hi')")).toBeNull();
    });

    it("resolves an unquoted call to the upper-case member whatever the source casing", () => {
      const source = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "bz_em_clean_rec_e(V0, IRET, SRET);");
      expect(resolveAt(source, bodyContext, "bz_em_clean_rec_e(V0")?.kind).toBe("document");
    });

    it("does not treat an unquoted qualifier as a quoted mixed-case package", () => {
      const mixedContext: OraclePackageSourceContext = { name: "MixedPkg", schema: "LLMES", objectType: "PACKAGE_BODY" };
      const unquoted = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "MixedPkg.BZ_EM_CLEAN_REC_E(V0, IRET, SRET);");
      expect(resolveAt(unquoted, mixedContext, "MixedPkg.BZ_EM_CLEAN_REC_E")).toBeNull();
      const quoted = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", `"MixedPkg".BZ_EM_CLEAN_REC_E(V0, IRET, SRET);`);
      expect(resolveAt(quoted, mixedContext, `"MixedPkg".BZ_EM_CLEAN_REC_E`, 13)?.kind).toBe("document");
    });

    it("keeps an unquoted package qualifier case-insensitive", () => {
      const source = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", "bz_em_pro.BZ_EM_CLEAN_REC_E(V0, IRET, SRET);");
      expect(resolveAt(source, bodyContext, "bz_em_pro.BZ_EM_CLEAN_REC_E")?.kind).toBe("document");
    });

    it("does not treat a quoted package qualifier of another case as this package", () => {
      const source = BODY.replace("BZ_EM_CLEAN_REC_E(V0, IRET, SRET);", `"bz_em_pro".BZ_EM_CLEAN_REC_E(V0, IRET, SRET);`);
      expect(resolveAt(source, bodyContext, `"bz_em_pro".BZ_EM_CLEAN_REC_E`, 13)).toBeNull();
    });
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
