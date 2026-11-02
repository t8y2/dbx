import { describe, expect, it } from "vitest";
import { buildPlDebugAnonymousBlockStartRequest, plSqlFirstKeyword, preparePlDebugAnonymousBlockSource, resolvePlDebugAnonymousBlockText, stripPlSqlComments } from "@/lib/debug/plDebugAnonymousBlock";

/**
 * F2：匿名块调试入口的文本契约。
 *
 * 提交给 agent 的文本必须**逐字节**是用户写的那段（除了去掉尾部的 `/`），因为调试器
 * 把采集语句插到最后一个 `END` 之前 —— 行号即用户源码行号，gutter 断点靠它对齐。
 * 另一半是拒绝：不是匿名块的文本必须在启动之前就被挡掉，而不是留给服务器报 PLS 错误。
 */

describe("stripPlSqlComments", () => {
  it("removes line and block comments but keeps line structure", () => {
    expect(stripPlSqlComments("-- banner\nBEGIN\n/* x */ NULL;\n-- tail\nEND;")).toBe("\nBEGIN\n NULL;\n\nEND;");
  });

  it("keeps a doubled quote inside a single-quoted literal, so a comment marker is not a comment", () => {
    expect(stripPlSqlComments("BEGIN x := 'a--b''c'; END;")).toBe("BEGIN x := 'a--b''c'; END;");
    expect(plSqlFirstKeyword("<<outer>> x := '*/'; BEGIN")).toBe("<<");
  });

  it("reports no keyword for comment-only or blank text", () => {
    expect(plSqlFirstKeyword("-- nothing here\n/* nor here */")).toBeNull();
    expect(plSqlFirstKeyword("   \n\t")).toBeNull();
  });

  it("upper-cases the first keyword and accepts a labelled block", () => {
    expect(plSqlFirstKeyword("declare x number; begin null; end;")).toBe("DECLARE");
    expect(plSqlFirstKeyword("  Begin\n NULL;\nEND;")).toBe("BEGIN");
    expect(plSqlFirstKeyword("<<outer>>\nBEGIN\n NULL;\nEND;")).toBe("<<");
  });
});

describe("preparePlDebugAnonymousBlockSource", () => {
  it("drops the trailing SQL*Plus slash and the blank lines around it", () => {
    expect(preparePlDebugAnonymousBlockSource("BEGIN\n  NULL;\nEND;\n/\n")).toBe("BEGIN\n  NULL;\nEND;");
    expect(preparePlDebugAnonymousBlockSource("BEGIN\n  NULL;\nEND;\n\n/\n")).toBe("BEGIN\n  NULL;\nEND;");
  });

  it("keeps every line above the block's END where the user put it", () => {
    const source = "DECLARE\n  v NUMBER;\nBEGIN\n\n  v := 1;\nEND;";
    expect(preparePlDebugAnonymousBlockSource(`${source}\n/`)).toBe(source);
  });

  it("normalizes CRLF so the submitted text is one shape", () => {
    expect(preparePlDebugAnonymousBlockSource("BEGIN\r\n  NULL;\r\nEND;\r\n/")).toBe("BEGIN\n  NULL;\nEND;");
  });

  it("does not remove a slash that is not the terminator", () => {
    // No trailing terminator: the division operator stays exactly where it is.
    expect(preparePlDebugAnonymousBlockSource("BEGIN\n  v := a / b;\nEND;")).toBe("BEGIN\n  v := a / b;\nEND;");
  });
});

describe("resolvePlDebugAnonymousBlockText", () => {
  it("prefers a non-blank selection over the whole document", () => {
    const result = resolvePlDebugAnonymousBlockText("BEGIN\n  NULL;\nEND;", "SELECT 1 FROM dual;");
    expect(result).toEqual({ ok: true, source: "BEGIN\n  NULL;\nEND;" });
  });

  it("falls back to the whole document when nothing is selected", () => {
    expect(resolvePlDebugAnonymousBlockText("   \n", "DECLARE\nBEGIN\n  NULL;\nEND;")).toEqual({ ok: true, source: "DECLARE\nBEGIN\n  NULL;\nEND;" });
  });

  it.each(["DECLARE\n  v NUMBER;\nBEGIN\n  NULL;\nEND;", "begin\n  null;\nend;", "<<outer>> declare x number; begin null; end;", "-- banner\n/* note */\nBEGIN\n  NULL;\nEND;"])("accepts %#", (text) => {
    expect(resolvePlDebugAnonymousBlockText(text, "").ok).toBe(true);
  });

  it.each(["SELECT 1 FROM dual;", "CALL p_demo();", "/* only a comment */"])("refuses %#", (text) => {
    expect(resolvePlDebugAnonymousBlockText(text, "")).toEqual({ ok: false, reason: "not-anonymous-block", source: text });
  });

  it("reports blank text as empty rather than invalid", () => {
    expect(resolvePlDebugAnonymousBlockText("  ", "\n\n")).toEqual({ ok: false, reason: "empty", source: "" });
  });
});

describe("buildPlDebugAnonymousBlockStartRequest", () => {
  it("sends the anonymous target with the block's own source and no parameters", () => {
    // 形状由 mock invoke 的 store 测试再钉一次（这条是纯函数的视角）。
    expect(buildPlDebugAnonymousBlockStartRequest({ schema: "APP", source: "BEGIN NULL; END;" })).toEqual({
      schema: "APP",
      objectType: "ANONYMOUS",
      objectName: null,
      packageName: null,
      source: "BEGIN NULL; END;",
      params: [],
    });
  });

  it("keeps a missing schema explicit as null", () => {
    expect(buildPlDebugAnonymousBlockStartRequest({ source: "BEGIN NULL; END;" }).schema).toBeNull();
  });
});
