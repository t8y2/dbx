/**
 * 「跳转到行」输入解析。
 *
 * 只做两件事：把用户在跳转框里输入的内容解析成行号，并给出该行在文档中的起始
 * 偏移。与 CodeMirror 解耦（只依赖 `lines` / `line()` 这两个成员），这样既能直
 * 接接收 `Text`，也能在单测里用最简桩对象覆盖边界情况。
 */

export interface EditorGotoLineDocument {
  readonly lines: number;
  line(number: number): { readonly number: number; readonly from: number };
}

export type EditorGotoLineFailure = "empty" | "invalid" | "out-of-range";

export type EditorGotoLineResolution = { ok: true; line: number; from: number } | { ok: false; reason: EditorGotoLineFailure };

/** 只接受十进制数字：`+1`、`1.5`、`1e3`、全角数字等一律视为无效输入。 */
const DECIMAL_DIGITS = /^\d+$/;

export function resolveEditorGotoLine(input: string, doc: EditorGotoLineDocument): EditorGotoLineResolution {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (!DECIMAL_DIGITS.test(trimmed)) return { ok: false, reason: "invalid" };
  const line = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(line) || line < 1 || line > doc.lines) return { ok: false, reason: "out-of-range" };
  return { ok: true, line, from: doc.line(line).from };
}

/** 跳转框的预填值：当前光标所在行（VS Code 同样的行为，直接回车即回到原处）。 */
export function currentEditorLineNumber(doc: EditorGotoLineDocument & { lineAt(position: number): { readonly number: number } }, position: number): number {
  return doc.lineAt(position).number;
}
