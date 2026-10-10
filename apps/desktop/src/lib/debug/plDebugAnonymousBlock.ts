import type { PlDebugStartRequest } from "@/lib/backend/pl-debug-tauri";

/**
 * Anonymous-block debugging: turning editor text into a source the debugger accepts.
 *
 * The Go agent compiles and runs the submitted text itself (`objectType:
 * "ANONYMOUS"`), inserting its DBMS_OUTPUT capture in front of the block's final
 * `END;` so every line above it keeps its original number -- which is what makes
 * the editor's gutter breakpoints valid. This module owns the frontend half of
 * that contract: what exactly gets submitted, and what is refused.
 */

/**
 * Removes `--` line comments and block comments while keeping the text's line
 * structure (comment characters become nothing, newlines inside comments survive).
 *
 * Single-quoted literals are copied through: `'a--b'` is data, not a comment, and
 * the doubled `''` escape stays inside the literal. Only the leading keyword check
 * needs this, but a naive `split("--")` would misread a block that starts with a
 * banner comment containing an apostrophe.
 */
export function stripPlSqlComments(text: string): string {
  let stripped = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      stripped += char;
      index += 1;
      while (index < text.length) {
        if (text[index] !== "'") {
          stripped += text[index];
          index += 1;
          continue;
        }
        stripped += "'";
        index += 1;
        // A doubled quote is an escaped quote, so the literal continues.
        if (text[index] !== "'") break;
        stripped += "'";
        index += 1;
      }
      continue;
    }
    if (char === "-" && text[index + 1] === "-") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") stripped += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    stripped += char;
    index += 1;
  }
  return stripped;
}

/**
 * The first keyword of the comment-free text, upper-cased.
 *
 * A labelled block (`<<outer>>`) has no keyword, so a literal `<<` is returned as
 * itself rather than as an empty string: the caller only has to compare against
 * three values.
 */
export function plSqlFirstKeyword(text: string): string | null {
  const stripped = stripPlSqlComments(text).trimStart();
  if (stripped.startsWith("<<")) return "<<";
  const match = /^([A-Za-z][A-Za-z0-9_$#]*)/.exec(stripped);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Normalizes submitted text: line endings to `\n`, and the trailing SQL*Plus `/`
 * terminator (plus the blank lines around it) removed.
 *
 * The `/` is a client-side execute command, not part of the block; the desktop
 * submits the block itself. Blank lines above the final `END;` are deliberately
 * kept, because every line above it must stay where the gutter breakpoints were
 * placed.
 */
export function preparePlDebugAnonymousBlockSource(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 0 && lines[lines.length - 1].trim() === "/") {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  }
  return lines.join("\n");
}

export type PlDebugAnonymousBlockTextResult = { ok: true; source: string } | { ok: false; reason: "empty" | "not-anonymous-block"; source: string };

/**
 * Resolves what to debug: the selection when there is one, the whole document
 * otherwise. The result is validated, not repaired -- a source the debugger would
 * hand to the server as-is must either be an anonymous block or be refused.
 */
export function resolvePlDebugAnonymousBlockText(selectedText: string, documentText: string): PlDebugAnonymousBlockTextResult {
  const source = preparePlDebugAnonymousBlockSource(selectedText.trim() ? selectedText : documentText);
  if (!source.trim()) return { ok: false, reason: "empty", source };
  const keyword = plSqlFirstKeyword(source);
  if (keyword !== "DECLARE" && keyword !== "BEGIN" && keyword !== "<<") {
    return { ok: false, reason: "not-anonymous-block", source };
  }
  return { ok: true, source };
}

/**
 * The `pl_debug_start` request for a prepared anonymous block. `params` stays an
 * empty array: an anonymous block declares its own variables, so there is no
 * parameter dialog to fill and no routine to address by name.
 */
export function buildPlDebugAnonymousBlockStartRequest(input: { schema?: string | null; source: string }): PlDebugStartRequest {
  return {
    schema: input.schema ?? null,
    objectType: "ANONYMOUS",
    objectName: null,
    packageName: null,
    source: input.source,
    params: [],
  };
}
