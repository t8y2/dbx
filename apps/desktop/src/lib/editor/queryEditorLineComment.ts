import type { DatabaseType } from "@/types/database";

const SQL_LINE_COMMENT_TOKEN = "--";

// Editors that speak a shell/script dialect instead of SQL keep their native line comment marker.
const LINE_COMMENT_TOKENS: Partial<Record<DatabaseType, string>> = {
  mongodb: "//",
};

export function queryEditorLineCommentToken(dbType?: DatabaseType): string {
  if (!dbType) return SQL_LINE_COMMENT_TOKEN;
  return LINE_COMMENT_TOKENS[dbType] ?? SQL_LINE_COMMENT_TOKEN;
}

export function queryEditorCommentTokens(dbType?: DatabaseType) {
  return {
    line: queryEditorLineCommentToken(dbType),
    block: { open: "/*", close: "*/" },
  };
}
