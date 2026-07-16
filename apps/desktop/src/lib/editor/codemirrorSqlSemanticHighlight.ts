import { sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";
import type { SqlSemanticBuildOptions, SqlSemanticSpan } from "@/lib/sql/semantic/types";

type SqlSyntaxTree = ReturnType<typeof import("@codemirror/language").syntaxTree>;

const SUPPRESSED_NODE_NAMES = new Set(["String", "LineComment", "BlockComment"]);

export interface SqlSemanticHighlightWindow {
  from: number;
  to: number;
}

function maskSuppressedSyntax(sql: string, window: SqlSemanticHighlightWindow, tree: SqlSyntaxTree): string {
  const ranges: SqlSemanticHighlightWindow[] = [];
  tree.iterate({
    from: window.from,
    to: window.to,
    enter(node) {
      if (!SUPPRESSED_NODE_NAMES.has(node.name)) return;
      ranges.push({ from: Math.max(window.from, node.from), to: Math.min(window.to, node.to) });
      return false;
    },
  });

  let cursor = window.from;
  let masked = "";
  for (const range of ranges) {
    if (range.from < cursor) continue;
    masked += sql.slice(cursor, range.from);
    masked += sql.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
    cursor = range.to;
  }
  return masked + sql.slice(cursor, window.to);
}

export function sqlSemanticTableNameSpansForSyntaxTree(sql: string, window: SqlSemanticHighlightWindow, tree: SqlSyntaxTree, options: SqlSemanticBuildOptions = {}): SqlSemanticSpan[] {
  const maskedSql = maskSuppressedSyntax(sql, window, tree);
  return sqlSemanticTableNameSpans(maskedSql, options).map((span) => ({ start: span.start + window.from, end: span.end + window.from }));
}
