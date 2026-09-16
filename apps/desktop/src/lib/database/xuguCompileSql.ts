/**
 * Xugu object kinds that support an explicit recompilation statement.
 * Keep this list intentionally narrow: the caller must still gate the action
 * to Xugu connections so other database dialects are not affected.
 */
const XUGU_COMPILE_KEYWORDS: Record<string, string> = {
  procedure: "PROCEDURE",
  function: "FUNCTION",
  trigger: "TRIGGER",
  package: "PACKAGE",
  "package-body": "PACKAGE",
  type: "TYPE",
  "type-body": "TYPE",
  PROCEDURE: "PROCEDURE",
  FUNCTION: "FUNCTION",
  TRIGGER: "TRIGGER",
  PACKAGE: "PACKAGE",
  PACKAGE_BODY: "PACKAGE",
  TYPE: "TYPE",
  TYPE_BODY: "TYPE",
};

export interface XuguCompileSqlInput {
  objectType: string;
  name: string;
  schema?: string;
}

export function xuguCompileKeyword(objectType: string): string | null {
  return XUGU_COMPILE_KEYWORDS[objectType] ?? null;
}

export function buildXuguCompileSql(input: XuguCompileSqlInput): string | null {
  const keyword = xuguCompileKeyword(input.objectType);
  const name = input.name.trim();
  if (!keyword || !name) return null;
  const qualifiedName = input.schema?.trim() ? `${quoteXuguIdentifier(input.schema.trim())}.${quoteXuguIdentifier(name)}` : quoteXuguIdentifier(name);
  return `ALTER ${keyword} ${qualifiedName} RECOMPILE;`;
}

function quoteXuguIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
