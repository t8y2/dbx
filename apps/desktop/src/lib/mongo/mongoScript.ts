import { trimMongoOuterComments } from "@dbx-app/mongo-shell";

// Statements the structured mongo shell parser cannot express but the embedded
// script runtime can: IIFEs, var/let/const, loops, callbacks and cursor helpers.
const SCRIPT_START = /^(?:\(|function\b|async\b|var\b|let\b|const\b|for\b|while\b|if\b|try\b|print\b|printjson\b)/;
const SCRIPT_MARKERS = /=>|\bfunction\b|\.(?:forEach|toArray|map|next|hasNext)\s*\(/;

/**
 * True when text that the structured parser rejected looks like a JavaScript
 * script. Callers only consult this after structured parsing failed, so plain
 * `db.x.find()` typos keep their dedicated diagnostics.
 */
export function looksLikeMongoScript(input: string): boolean {
  const source = trimMongoOuterComments(input).trim();
  if (!source) return false;
  return SCRIPT_START.test(source) || SCRIPT_MARKERS.test(source);
}
