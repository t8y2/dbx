const IDENTIFIER_START = /^[A-Za-z_@$#\p{ID_Start}]$/u;
const IDENTIFIER_PART = /^[A-Za-z0-9_@$#\p{ID_Continue}]$/u;

// MySQL permits these BMP characters in unquoted names, including at the start.
// Keep this addition dialect-specific: an IME typo in a function call is not a
// reason to split a valid MySQL table/column name (#14111).
export const MYSQL_FULLWIDTH_IDENTIFIER_CHARACTERS = "（）";

export function isFullwidthParenthesis(char: string | undefined): boolean {
  return char === "（" || char === "）";
}

export function isSqlIdentifierStart(char: string | undefined, dialectId = "generic"): boolean {
  return !!char && (IDENTIFIER_START.test(char) || (dialectId === "mysql" && isFullwidthParenthesis(char)));
}

export function isSqlIdentifierPart(char: string | undefined, dialectId = "generic"): boolean {
  return !!char && (IDENTIFIER_PART.test(char) || (dialectId === "mysql" && isFullwidthParenthesis(char)));
}
