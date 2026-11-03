import { describe, expect, it } from "vitest";
import { resolveRoutineEntryLine, routineProgramName, routineSourceObject } from "@/lib/debug/oracleRoutineEntryLine";

/**
 * F3：子程序入口断点的行号解析。
 *
 * 行号错位的表现是「断点设上了但程序不按预期停」，比一个明确的失败难查得多，所以这里
 * 把「头行 + 体首条语句」的解析边界逐条钉住：独立过程、包成员（包体行号）、声明区与
 * 嵌套 BEGIN、以及**找不到就必须返回 null**（调用方据此报错，不许猜行号）。
 */

const STANDALONE_PROCEDURE = ["PROCEDURE DO_WORK (P_ID IN NUMBER) IS", "  V_COUNT NUMBER;", "BEGIN", "  V_COUNT := P_ID + 1;", "  DBMS_OUTPUT.PUT_LINE(V_COUNT);", "END DO_WORK;", ""].join("\n");

const PACKAGE_BODY = [
  "PACKAGE BODY PKG IS",
  "",
  "  PROCEDURE SUB_A (P IN NUMBER) IS",
  "  BEGIN",
  "    NULL;",
  "  END SUB_A;",
  "",
  "  FUNCTION F_B RETURN NUMBER IS",
  "    V NUMBER := 1;",
  "  BEGIN",
  "    RETURN V;",
  "  END F_B;",
  "",
  "BEGIN",
  "  -- package initialization",
  "  NULL;",
  "END PKG;",
].join("\n");

describe("resolveRoutineEntryLine on a standalone routine", () => {
  it("returns the header line and the first executable line of the body", () => {
    expect(resolveRoutineEntryLine(STANDALONE_PROCEDURE, "DO_WORK")).toEqual({ headLine: 1, candidateLine: 4 });
  });

  it("matches the name case-insensitively and accepts a quoted dictionary name", () => {
    expect(resolveRoutineEntryLine(STANDALONE_PROCEDURE, "do_work")?.headLine).toBe(1);
    const quoted = 'PROCEDURE "doWork" IS\nBEGIN\n  NULL;\nEND;\n';
    expect(resolveRoutineEntryLine(quoted, '"doWork"')).toEqual({ headLine: 1, candidateLine: 3 });
  });

  it("accepts the editable form that carries a CREATE OR REPLACE prefix", () => {
    const editable = "CREATE OR REPLACE PROCEDURE DO_WORK IS\nBEGIN\n  NULL;\nEND DO_WORK;\n/\n";
    expect(resolveRoutineEntryLine(editable, "DO_WORK")).toEqual({ headLine: 1, candidateLine: 3 });
  });

  it("skips a declaration section and a nested subprogram before the routine's own BEGIN", () => {
    // 声明的嵌套子程序自己有一个 BEGIN；头行之后的第一个 BEGIN 是**它的**，不是目标的。
    const source = ["FUNCTION OUTER_F RETURN NUMBER IS", "  V NUMBER := 0;", "  PROCEDURE INNER IS", "  BEGIN", "    NULL;", "  END INNER;", "BEGIN", "  INNER;", "  RETURN V;", "END OUTER_F;"].join("\n");
    expect(resolveRoutineEntryLine(source, "OUTER_F")).toEqual({ headLine: 1, candidateLine: 8 });
    expect(resolveRoutineEntryLine(source, "INNER")).toEqual({ headLine: 3, candidateLine: 5 });
  });

  it("takes the first line of a body that opens with a nested block", () => {
    const source = ["PROCEDURE P IS", "  V NUMBER;", "BEGIN", "  BEGIN", "    NULL;", "  END;", "END P;"].join("\n");
    // 体首条语句是嵌套块的 BEGIN 行（声明区与嵌套块都不会被当成体）。
    expect(resolveRoutineEntryLine(source, "P")).toEqual({ headLine: 1, candidateLine: 4 });
  });

  it("ignores comment-only lines and comment markers inside the header's own text", () => {
    const source = ["-- banner: PROCEDURE DECOY IS", "/* PROCEDURE DECOY2 IS */", "PROCEDURE REAL_P IS", "  V NUMBER;", "BEGIN", "  -- only a comment", "  NULL;", "END REAL_P;"].join("\n");
    expect(resolveRoutineEntryLine(source, "REAL_P")).toEqual({ headLine: 3, candidateLine: 7 });
  });

  it("returns candidateLine null when the body has no statement of its own", () => {
    const source = ["PROCEDURE EMPTY_P IS", "BEGIN", "END EMPTY_P;"].join("\n");
    expect(resolveRoutineEntryLine(source, "EMPTY_P")).toEqual({ headLine: 1, candidateLine: null });
    // 整段写在一行时也没有单独的体行，但头行仍然可断。
    expect(resolveRoutineEntryLine("PROCEDURE ONE_LINER IS BEGIN NULL; END;", "ONE_LINER")).toEqual({ headLine: 1, candidateLine: null });
  });

  it("returns null when the routine is not in the source, so the caller reports instead of guessing", () => {
    expect(resolveRoutineEntryLine(STANDALONE_PROCEDURE, "SOMEONE_ELSE")).toBeNull();
    expect(resolveRoutineEntryLine("", "DO_WORK")).toBeNull();
    expect(resolveRoutineEntryLine(STANDALONE_PROCEDURE, "   ")).toBeNull();
  });
});

describe("resolveRoutineEntryLine inside a package body", () => {
  it("finds each member and never mistakes the package body's own initialization section for a member body", () => {
    expect(resolveRoutineEntryLine(PACKAGE_BODY, "SUB_A")).toEqual({ headLine: 3, candidateLine: 5 });
    expect(resolveRoutineEntryLine(PACKAGE_BODY, "F_B")).toEqual({ headLine: 8, candidateLine: 11 });
  });

  it("does not treat the package's BEGIN as the member's body", () => {
    // SUB_A 自己的 BEGIN 在第 4 行；第 14 行的包初始化 BEGIN 绝不能被当成它的体首行。
    expect(resolveRoutineEntryLine(PACKAGE_BODY, "PKG")).toBeNull();
    expect(resolveRoutineEntryLine(PACKAGE_BODY, "SUB_A")?.candidateLine).toBe(5);
  });

  it("returns the package body's line numbers, which are the ones DBMS_DEBUG breaks on", () => {
    const lines = PACKAGE_BODY.split("\n");
    expect(lines[resolveRoutineEntryLine(PACKAGE_BODY, "SUB_A")!.headLine - 1]).toContain("PROCEDURE SUB_A");
    expect(lines[resolveRoutineEntryLine(PACKAGE_BODY, "F_B")!.candidateLine! - 1].trim()).toBe("RETURN V;");
  });
});

describe("dictionary object and program name of a routine", () => {
  it("loads a standalone routine's own source and addresses it by its bare name", () => {
    expect(routineSourceObject({ objectName: "DO_WORK", objectType: "PROCEDURE" })).toEqual({ name: "DO_WORK", objectType: "PROCEDURE" });
    expect(routineSourceObject({ objectName: "DO_WORK", objectType: "FUNCTION" })).toEqual({ name: "DO_WORK", objectType: "FUNCTION" });
    expect(routineProgramName({ objectName: "DO_WORK" })).toBe("DO_WORK");
  });

  it("loads a package member's line numbers from the package body and addresses it as PKG.SUB", () => {
    expect(routineSourceObject({ objectName: "SUB_A", objectType: "PROCEDURE", packageName: "PKG" })).toEqual({ name: "PKG", objectType: "PACKAGE_BODY" });
    expect(routineProgramName({ objectName: "SUB_A", packageName: "PKG" })).toBe("PKG.SUB_A");
  });

  it("has no source object for a kind that is not a routine", () => {
    expect(routineSourceObject({ objectName: "T", objectType: "TABLE" })).toBeNull();
    expect(routineSourceObject({ objectName: "  ", objectType: "PROCEDURE" })).toBeNull();
  });
});
