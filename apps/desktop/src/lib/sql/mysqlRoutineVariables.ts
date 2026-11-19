import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

type Scope = { kind: string; depth: number; variables: string[] };
const CONTROL_BLOCKS = new Set(["if", "loop", "while", "repeat"]);
const OTHER_CREATE_OBJECTS = new Set(["table", "view", "trigger", "event", "database", "schema", "index", "user", "role"]);

function identifier(token: SqlSemanticToken | undefined): string | undefined {
  if (!token || (token.kind !== "word" && !(token.kind === "quoted_identifier" && token.quote === "`"))) return undefined;
  if (token.text.startsWith("@")) return undefined;
  return token.kind === "quoted_identifier" ? token.text.slice(1, -1).replaceAll("``", "`") : token.text;
}

function declarationNames(tokens: SqlSemanticToken[], start: number): string[] {
  const names: string[] = [];
  let index = start;
  while (index < tokens.length) {
    const name = identifier(tokens[index]);
    if (!name) return [];
    names.push(name);
    index += 1;
    if (tokens[index]?.text !== ",") break;
    index += 1;
  }
  const type = tokens[index];
  // Cursor, condition and handler declarations share DECLARE's prefix, but do
  // not introduce scalar values that can be used in SQL expressions.
  if (type?.kind !== "word" || ["condition", "cursor", "handler"].includes(type.normalized) || ["continue", "exit", "undo"].includes(tokens[start]?.normalized ?? "")) return [];
  return names;
}

/** Values visible at the cursor in a MySQL procedure or function definition. */
export function collectMysqlRoutineVariables(sql: string, cursor: number): string[] {
  let beforeCursor = sql.slice(0, Math.max(0, Math.min(cursor, sql.length)));
  if (!/\b(?:procedure|function)\b/i.test(beforeCursor)) return [];
  // Client delimiters such as END$$ are not SQL words. Let the execution
  // splitter isolate the current definition instead of tokenizing its suffix.
  if (/^\s*delimiter(?:[ \t]|;)/im.test(beforeCursor)) {
    const statements = splitSqlStatementRanges(beforeCursor, "mysql");
    const statement = statements[statements.length - 1];
    if (!statement || beforeCursor.slice(statement.to).trim()) return [];
    beforeCursor = beforeCursor.slice(statement.from, statement.to);
  }
  const tokens = tokenizeSqlSemantic(beforeCursor, "mysql", { mysqlDoubleQuoteIsString: true }).filter((token) => token.kind !== "comment");
  let parameters: string[] | undefined;
  const scopes: Scope[] = [];
  let startedBody = false;
  let statementStart = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const word = token.kind === "word" && tokens[index - 1]?.text !== "." ? token.normalized : "";
    if (!parameters && token.depth === 0 && word === "create") {
      let routine = index + 1;
      while (routine < tokens.length) {
        const current = tokens[routine]!;
        if (current.text === ";" || (current.kind === "word" && OTHER_CREATE_OBJECTS.has(current.normalized))) break;
        if (current.depth === 0 && current.kind === "word" && ["procedure", "function"].includes(current.normalized)) break;
        routine += 1;
      }
      if (!["procedure", "function"].includes(tokens[routine]?.normalized ?? "")) continue;
      let open = routine + 1;
      if (!identifier(tokens[open])) continue;
      open += 1;
      if (tokens[open]?.text === ".") {
        if (!identifier(tokens[open + 1])) continue;
        open += 2;
      }
      if (tokens[open]?.text !== "(") continue;
      let close = open + 1;
      while (close < tokens.length && !(tokens[close]?.text === ")" && tokens[close]?.depth === 0)) close += 1;
      if (close === tokens.length) continue;
      parameters = [];
      for (let parameter = open + 1; parameter < close; parameter += 1) {
        if (parameter !== open + 1 && !(tokens[parameter - 1]?.text === "," && tokens[parameter - 1]?.depth === 1)) continue;
        if (["in", "out", "inout"].includes(tokens[parameter]?.normalized ?? "")) parameter += 1;
        const name = identifier(tokens[parameter]);
        if (name && tokens[parameter + 1]?.kind === "word") parameters.push(name);
      }
      startedBody = false;
      statementStart = true;
      index = close;
      continue;
    }
    if (!parameters) continue;

    if (word === "end") {
      const scope = scopes[scopes.length - 1];
      if (scope?.depth === token.depth) {
        scopes.pop();
        if (scopes.length === 0 && startedBody) parameters = undefined;
        // END IF / END CASE / END LOOP are one closing construct; their second
        // keyword must not open another block. Expression CASE uses bare END.
        const suffix = tokens[index + 1];
        if (suffix?.kind === "word" && suffix.normalized === scope.kind) index += 1;
      }
      statementStart = false;
      continue;
    }
    if ((word === "begin" && token.depth === 0) || word === "case" || (statementStart && token.depth === 0 && CONTROL_BLOCKS.has(word))) {
      scopes.push({ kind: word, depth: token.depth, variables: [] });
      if (word === "begin") startedBody = true;
      statementStart = word === "begin" || word === "loop" || word === "repeat";
      continue;
    }
    const declarationScope = scopes[scopes.length - 1];
    if (statementStart && word === "declare" && declarationScope?.kind === "begin") {
      declarationScope.variables.push(...declarationNames(tokens, index + 1));
    }
    if (token.text === ";" && token.depth === 0) {
      // A routine with a single RETURN / SELECT body has no BEGIN..END pair.
      if (!startedBody) parameters = undefined;
      statementStart = true;
    } else {
      statementStart = token.depth === 0 && (token.text === ":" || ["then", "else", "do"].includes(word));
    }
  }
  if (!parameters) return [];
  // Innermost declarations shadow outer names, including routine parameters.
  const visible = new Map<string, string>();
  for (const name of [...parameters, ...scopes.flatMap((scope) => scope.variables)]) visible.set(name.toLowerCase(), name);
  return [...visible.values()];
}
