import { describe, expect, it } from "vitest";
import { currentEditorLineNumber, resolveEditorGotoLine, type EditorGotoLineDocument } from "@/lib/editor/editorGotoLine";

/** 用固定行宽（10 字符/行）的桩对象代替 CodeMirror 的 Text。 */
function makeDoc(lines: number): EditorGotoLineDocument & { lineAt(position: number): { number: number } } {
  return {
    lines,
    line: (number: number) => ({ number, from: (number - 1) * 10 }),
    lineAt: (position: number) => ({ number: Math.floor(position / 10) + 1 }),
  };
}

describe("resolveEditorGotoLine", () => {
  it("解析合法行号并给出该行起始偏移", () => {
    const doc = makeDoc(150);
    expect(resolveEditorGotoLine("1", doc)).toEqual({ ok: true, line: 1, from: 0 });
    expect(resolveEditorGotoLine("42", doc)).toEqual({ ok: true, line: 42, from: 410 });
    expect(resolveEditorGotoLine("150", doc)).toEqual({ ok: true, line: 150, from: 1490 });
  });

  it("忽略首尾空白", () => {
    expect(resolveEditorGotoLine("  7  ", makeDoc(10))).toEqual({ ok: true, line: 7, from: 60 });
  });

  it("空输入按 empty 处理", () => {
    expect(resolveEditorGotoLine("", makeDoc(10))).toEqual({ ok: false, reason: "empty" });
    expect(resolveEditorGotoLine("   ", makeDoc(10))).toEqual({ ok: false, reason: "empty" });
  });

  it("非十进制数字按 invalid 处理", () => {
    for (const value of ["abc", "1.5", "1e3", "+1", "-1", "１２", "1 2", "0x10"]) {
      expect(resolveEditorGotoLine(value, makeDoc(10))).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("越界行号按 out-of-range 处理", () => {
    const doc = makeDoc(10);
    expect(resolveEditorGotoLine("0", doc)).toEqual({ ok: false, reason: "out-of-range" });
    expect(resolveEditorGotoLine("11", doc)).toEqual({ ok: false, reason: "out-of-range" });
    expect(resolveEditorGotoLine("999999999999999999999", doc)).toEqual({ ok: false, reason: "out-of-range" });
  });

  it("单行文档只接受第 1 行", () => {
    const doc = makeDoc(1);
    expect(resolveEditorGotoLine("1", doc)).toEqual({ ok: true, line: 1, from: 0 });
    expect(resolveEditorGotoLine("2", doc)).toEqual({ ok: false, reason: "out-of-range" });
  });
});

describe("currentEditorLineNumber", () => {
  it("返回光标所在行号", () => {
    const doc = makeDoc(20);
    expect(currentEditorLineNumber(doc, 0)).toBe(1);
    expect(currentEditorLineNumber(doc, 95)).toBe(10);
    expect(currentEditorLineNumber(doc, 199)).toBe(20);
  });
});
