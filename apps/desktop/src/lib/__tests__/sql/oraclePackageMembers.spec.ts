import { describe, expect, it } from "vitest";
import { findOraclePackageMember, oraclePackageMemberEntries, oracleRoutineSignatureParameters } from "@/lib/sql/oraclePackageMembers";

const PACKAGE_SPEC = `CREATE OR REPLACE PACKAGE SCOTT.SALES_PKG AS
  -- PROCEDURE COMMENTED_OUT(X IN NUMBER);
  PROCEDURE LOAD_FEEDS(VO IN SCOTT.ID_LIST_TYPE,
                       IRET OUT VARCHAR2,
                       SRET OUT VARCHAR2);
  PROCEDURE LOAD_SHIPMENTS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2);
  FUNCTION NEXT_SEQ(P_NAME IN VARCHAR2) RETURN NUMBER;
END SALES_PKG;`;

const PACKAGE_BODY = `CREATE OR REPLACE PACKAGE BODY SCOTT.SALES_PKG AS
  PROCEDURE LOAD_FEEDS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
  BEGIN
    IRET := '0';
  END LOAD_FEEDS;

  PROCEDURE LOAD_SHIPMENTS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
    V_COUNT NUMBER := 0;
  BEGIN
    SELECT COUNT(*) INTO V_COUNT FROM DUAL;
    IRET := '0';
  END LOAD_SHIPMENTS;

  FUNCTION NEXT_SEQ(P_NAME IN VARCHAR2) RETURN NUMBER IS
  BEGIN
    RETURN 1;
  END NEXT_SEQ;
END SALES_PKG;`;

function lineAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  return source.slice(start, end < 0 ? source.length : end).trim();
}

describe("oraclePackageMemberEntries", () => {
  it("reads declarations out of a package spec without treating them as implementations", () => {
    const entries = oraclePackageMemberEntries(PACKAGE_SPEC);
    expect(entries.map((entry) => [entry.name, entry.isFunction, entry.implemented, entry.parameters])).toEqual([
      ["LOAD_FEEDS", false, false, ["VO", "IRET", "SRET"]],
      ["LOAD_SHIPMENTS", false, false, ["VO", "IRET", "SRET"]],
      ["NEXT_SEQ", true, false, ["P_NAME"]],
    ]);
  });

  it("marks package body subprograms as implementations and reports their line", () => {
    const entries = oraclePackageMemberEntries(PACKAGE_BODY);
    expect(entries.map((entry) => [entry.name, entry.implemented])).toEqual([
      ["LOAD_FEEDS", true],
      ["LOAD_SHIPMENTS", true],
      ["NEXT_SEQ", true],
    ]);
    expect(entries[1]!.line).toBe(7);
    expect(lineAt(PACKAGE_BODY, entries[1]!.offset)).toBe("PROCEDURE LOAD_SHIPMENTS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS");
  });

  it("ignores subprogram headers inside comments and qualified calls", () => {
    const source = `CREATE OR REPLACE PACKAGE BODY P AS
  PROCEDURE RUN IS
  BEGIN
    OTHER_PKG.PROCEDURE_LIKE_NAME;
  END RUN;
END P;`;
    expect(oraclePackageMemberEntries(source).map((entry) => entry.name)).toEqual(["RUN"]);
  });

  it("reuses the last parse so the outline and the cursor jump tokenize once", () => {
    const first = oraclePackageMemberEntries(PACKAGE_BODY);
    // 同一份源码（大包体 tokenize 一次约 180ms，两个调用方各跑一次就是两倍）。
    expect(oraclePackageMemberEntries(PACKAGE_BODY)).toBe(first);
    // 内容变了必须重新解析，不能把上一份结果端出来。
    const edited = PACKAGE_BODY.replace("LOAD_SHIPMENTS", "LOAD_SHIPMENTS_V2");
    const second = oraclePackageMemberEntries(edited);
    expect(second).not.toBe(first);
    expect(second.map((entry) => entry.name)).toContain("LOAD_SHIPMENTS_V2");
    expect(oraclePackageMemberEntries(PACKAGE_BODY).map((entry) => entry.name)).toContain("LOAD_SHIPMENTS");
  });

  it("keeps parameter names out of nested default expressions", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE RUN(P_A IN NUMBER DEFAULT NVL(TRUNC(SYSDATE), 0), P_B IN VARCHAR2) IS
  BEGIN
    NULL;
  END RUN;
END P;`;
    expect(oraclePackageMemberEntries(source)[0]!.parameters).toEqual(["P_A", "P_B"]);
  });
});

describe("oracleRoutineSignatureParameters", () => {
  it("reads the dictionary signature text", () => {
    expect(oracleRoutineSignatureParameters("VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2")).toEqual(["VO", "IRET", "SRET"]);
    expect(oracleRoutineSignatureParameters("")).toEqual([]);
  });
});

describe("findOraclePackageMember", () => {
  it("locates a member implementation in the package body", () => {
    const member = findOraclePackageMember(PACKAGE_BODY, { name: "LOAD_SHIPMENTS", kind: "procedure", signature: "VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2" });
    expect(member?.line).toBe(7);
    expect(member?.implemented).toBe(true);
  });

  it("falls back to the spec declaration when only the spec is available", () => {
    const member = findOraclePackageMember(PACKAGE_SPEC, { name: "LOAD_SHIPMENTS", kind: "procedure" });
    expect(member?.line).toBe(6);
    expect(member?.implemented).toBe(false);
  });

  it("prefers the implementation over a forward declaration of the same name", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE RUN(P_A IN NUMBER);
  PROCEDURE RUN(P_A IN NUMBER) IS
  BEGIN
    NULL;
  END RUN;
END P;`;
    expect(findOraclePackageMember(source, { name: "RUN", kind: "procedure" })?.line).toBe(3);
  });

  it("picks the right overload by parameter names", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE RUN(P_ID IN NUMBER) IS
  BEGIN
    NULL;
  END RUN;
  PROCEDURE RUN(P_NAME IN VARCHAR2, P_FLAG IN CHAR) IS
  BEGIN
    NULL;
  END RUN;
END P;`;
    expect(findOraclePackageMember(source, { name: "RUN", kind: "procedure", signature: "P_NAME IN VARCHAR2, P_FLAG IN CHAR" })?.line).toBe(6);
    expect(findOraclePackageMember(source, { name: "RUN", kind: "procedure", signature: "P_ID IN NUMBER" })?.line).toBe(2);
  });

  it("distinguishes same-name parameters by datatype and avoids guessing when no signature is available", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE RUN(P_ID NUMBER) IS BEGIN NULL; END;
  PROCEDURE RUN(P_ID VARCHAR2) IS BEGIN NULL; END;
END P;`;
    expect(findOraclePackageMember(source, { name: "RUN", signature: "P_ID IN NUMBER(10,0)" })?.line).toBe(2);
    expect(findOraclePackageMember(source, { name: "RUN", signature: "P_ID IN VARCHAR2(30)" })?.line).toBe(3);
    expect(findOraclePackageMember(source, { name: "RUN", signature: "P_ID IN DATE" })).toBeNull();
    expect(findOraclePackageMember(source, { name: "RUN" })).toBeNull();
  });

  it("matches qualified datatypes after comparing exact types", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE RUN(P_ID VARCHAR2) IS BEGIN NULL; END;
  PROCEDURE RUN(P_ID ID_LIST_TYPE) IS BEGIN NULL; END;
END P;`;
    expect(findOraclePackageMember(source, { name: "RUN", signature: "P_ID IN SCOTT.ID_LIST_TYPE" })?.line).toBe(3);
  });

  it("lists and locates only package-level members after a nested subprogram and control blocks", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE WRAPPER IS
    PROCEDURE RUN(P_ID IN NUMBER) IS BEGIN NULL; END;
  BEGIN
    IF 1 = 1 THEN
      FOR i IN 1..1 LOOP
        BEGIN
          RUN(CASE WHEN i = 1 THEN i ELSE 0 END);
        END;
      END LOOP;
    END IF;
    CASE WHEN 1 = 1 THEN NULL; ELSE NULL; END CASE;
  END WRAPPER;
  PROCEDURE RUN(P_ID IN NUMBER) IS BEGIN NULL; END;
END P;`;
    expect(oraclePackageMemberEntries(source).map((entry) => entry.name)).toEqual(["WRAPPER", "RUN"]);
    expect(findOraclePackageMember(source, { name: "RUN", signature: "P_ID IN NUMBER" })?.line).toBe(14);
  });

  it("separates a function from a procedure that shares its name", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE SAME IS
  BEGIN
    NULL;
  END SAME;
  FUNCTION SAME RETURN NUMBER IS
  BEGIN
    RETURN 1;
  END SAME;
END P;`;
    expect(findOraclePackageMember(source, { name: "SAME", kind: "function" })?.line).toBe(6);
    expect(findOraclePackageMember(source, { name: "SAME", kind: "procedure" })?.line).toBe(2);
  });

  it("matches a quoted member name and a dictionary name case-insensitively", () => {
    const source = `PACKAGE BODY P AS
  PROCEDURE "MixedCase" IS
  BEGIN
    NULL;
  END "MixedCase";
END P;`;
    expect(findOraclePackageMember(source, { name: '"MixedCase"', kind: "procedure" })?.line).toBe(2);
    expect(findOraclePackageMember(source, { name: "mixedcase", kind: "procedure" })?.line).toBe(2);
  });

  it("matches a dictionary signature against a body that omits the mode and type owner", () => {
    // 真机形状（SCOTT.SALES_PKG）：包体写 `V0   ID_LIST_TYPE`（不写 IN、不带 owner）、
    // 参数表跨多行，而数据字典给的是 `V0 IN SCOTT.ID_LIST_TYPE`。消歧只比形参名，
    // 所以两边对得上；用类型文本匹配就会在这里落空。
    const source = `CREATE OR REPLACE PACKAGE BODY SCOTT.SALES_PKG AS
  PROCEDURE LOAD_FEEDS(V0   ID_LIST_TYPE,
                       IRET OUT VARCHAR2,
                       SRET OUT VARCHAR2) IS
  BEGIN
    NULL;
  END LOAD_FEEDS;
END SALES_PKG;`;
    const member = findOraclePackageMember(source, { name: "LOAD_FEEDS", kind: "procedure", signature: "V0 IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2" });
    expect(member?.line).toBe(2);
    expect(member?.parameters).toEqual(["V0", "IRET", "SRET"]);
  });

  it("returns null instead of guessing when the member is absent", () => {
    expect(findOraclePackageMember(PACKAGE_BODY, { name: "NOT_THERE", kind: "procedure" })).toBeNull();
    expect(findOraclePackageMember(PACKAGE_BODY, { name: "   ", kind: "procedure" })).toBeNull();
  });
});
