/**
 * Oracle object compilation and the read-back of its result.
 *
 * Oracle's `ALTER <kind> <name> COMPILE` answers success even when the object ends up
 * INVALID: the diagnostics live in `ALL_ERRORS`, not in the DDL's own result. So a compile
 * that a user can trust is two statements -- the compile, then the error read-back -- and
 * the caller reports the read-back rather than the DDL's return value.
 *
 * The SQL builders are pure functions on purpose (the repo's Dameng/Xugu compile helpers
 * are the same shape) so the identifier and literal escaping is unit-testable without a
 * connection.
 */

interface OracleCompileTarget {
  /** The keyword in `ALTER <keyword> <name> COMPILE`. */
  keyword: string;
  /** Whether the statement has to end in `BODY` to name a body instead of the spec. */
  body: boolean;
}

/**
 * The kinds Oracle can recompile, in both the tree's lower-case and upper-case spellings.
 * A package and a type have no separate "body object": `COMPILE` reaches both parts and
 * `COMPILE BODY` reaches only the body, so the body kinds map onto the owning keyword.
 */
const ORACLE_COMPILE_TARGETS: Record<string, OracleCompileTarget> = {
  view: { keyword: "VIEW", body: false },
  procedure: { keyword: "PROCEDURE", body: false },
  function: { keyword: "FUNCTION", body: false },
  package: { keyword: "PACKAGE", body: false },
  "package-body": { keyword: "PACKAGE", body: true },
  trigger: { keyword: "TRIGGER", body: false },
  type: { keyword: "TYPE", body: false },
  "type-body": { keyword: "TYPE", body: true },
  VIEW: { keyword: "VIEW", body: false },
  PROCEDURE: { keyword: "PROCEDURE", body: false },
  FUNCTION: { keyword: "FUNCTION", body: false },
  PACKAGE: { keyword: "PACKAGE", body: false },
  PACKAGE_BODY: { keyword: "PACKAGE", body: true },
  TRIGGER: { keyword: "TRIGGER", body: false },
  TYPE: { keyword: "TYPE", body: false },
  TYPE_BODY: { keyword: "TYPE", body: true },
};

export interface OracleCompileSqlInput {
  objectType: string;
  name: string;
  schema?: string;
}

/** The compilable target for an object kind, or null when Oracle cannot recompile it. */
export function oracleCompileTarget(objectType: string): OracleCompileTarget | null {
  return ORACLE_COMPILE_TARGETS[objectType] ?? null;
}

/**
 * `ALTER <kind> <schema>.<name> COMPILE[ BODY];`, or null for a kind Oracle cannot
 * recompile or a blank name. Identifiers are quoted with embedded quotes doubled, so a
 * mixed-case or oddly named object is addressed exactly as the dictionary spells it.
 */
export function buildOracleCompileSql(input: OracleCompileSqlInput): string | null {
  const target = oracleCompileTarget(input.objectType);
  const name = input.name.trim();
  if (!target || !name) return null;
  const schema = input.schema?.trim();
  const qualified = schema ? `${quoteOracleIdentifier(schema)}.${quoteOracleIdentifier(name)}` : quoteOracleIdentifier(name);
  return `ALTER ${target.keyword} ${qualified} COMPILE${target.body ? " BODY" : ""};`;
}

/**
 * The `ALL_ERRORS` read-back for one object, or null when the name is blank.
 *
 * `NAME` is compared exactly, not upper-cased: the caller passes the dictionary name from
 * the tree, and upper-casing would merge an object created with a quoted lower-case name
 * with a different upper-case object. Only the object's owner and name are filtered, so a
 * package returns the errors of its body whichever part was compiled.
 */
export function buildOracleCompileErrorsSql(input: { schema?: string; name: string }): string | null {
  const name = input.name.trim();
  if (!name) return null;
  const owner = input.schema?.trim();
  const ownerPredicate = owner ? `OWNER = ${oracleStringLiteral(owner)} AND ` : "";
  return `SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE ${ownerPredicate}NAME = ${oracleStringLiteral(name)} ORDER BY SEQUENCE`;
}

/**
 * Renders `[line, position, text]` rows as the dialog's message body, one diagnostic per
 * line. Anything that is not such a row is skipped rather than rendered as "undefined":
 * the read-back runs through the normal query path, so an unexpected shape must not turn
 * into a misleading compile error.
 */
export function formatOracleCompileErrors(rows: unknown): string {
  if (!Array.isArray(rows)) return "";
  const lines: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const text = String(row[2] ?? "").trim();
    if (!text) continue;
    const line = row[0] === null || row[0] === undefined ? "?" : String(row[0]);
    const position = row[1] === null || row[1] === undefined ? "?" : String(row[1]);
    lines.push(`LINE ${line}, COL ${position}: ${text}`);
  }
  return lines.join("\n");
}

function quoteOracleIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function oracleStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
