import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { cassandra, msSQL, mySQL, pgSQL, plSQL, sqlite, standardSQL } from "@codemirror/legacy-modes/mode/sql";
import type { DatabaseType } from "@/types/database";
import { codeMirrorBaseDialect, type CodeMirrorSqlDialectName, type CodeMirrorSqlLanguageModule } from "./codemirrorSqlDialect";
import { readSqlBracedParameterAt, type SqlParameterOptions } from "@/lib/sql/sqlParameters";

// Loaded only with the editor, never from the startup graph: it pulls in @codemirror/language.

const languageByParser = new Map<StreamParser<unknown>, StreamLanguage<unknown>>();

// The legacy SQL stream parser changes `tokenize` inside strings and block
// comments. Intercept parameters only in its normal SQL state, then delegate
// the token bookkeeping (including indentation) to the original parser.
const mysqlBaseTokenizer = (mySQL.startState!(2) as { tokenize: typeof mySQL.token }).tokenize;
const mysqlParameterParser: StreamParser<unknown> = {
  ...mySQL,
  token(stream, state) {
    const sqlState = state as { tokenize: typeof mySQL.token };
    if (sqlState.tokenize !== mysqlBaseTokenizer || !stream.string.startsWith("#{", stream.pos)) return mySQL.token(stream, state);
    const parameter = readSqlBracedParameterAt(stream.string, stream.pos);
    if (!parameter) return mySQL.token(stream, state);
    sqlState.tokenize = () => {
      stream.pos = parameter.end;
      return "variableName";
    };
    try {
      return mySQL.token(stream, state);
    } finally {
      sqlState.tokenize = mysqlBaseTokenizer;
    }
  },
};

export function largeDocumentSqlStreamParser(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName = "mysql", databaseType?: DatabaseType): StreamParser<unknown> {
  const base = codeMirrorBaseDialect(langSql, dialectName, databaseType);
  if (base === langSql.MySQL) return mySQL;
  if (base === langSql.PostgreSQL) return pgSQL;
  if (base === langSql.MSSQL) return msSQL;
  if (base === langSql.PLSQL) return plSQL;
  if (base === langSql.SQLite) return sqlite;
  if (base === langSql.Cassandra) return cassandra;
  return standardSQL;
}

/**
 * SQL highlighting for documents too large for the Lezer grammar. A stream language tokenizes line by
 * line and keeps no syntax tree, so highlighting a viewport at the end of a 12 MB document produced
 * ~280 MB of short-lived objects instead of ~1.2 GB. It follows the same dialect family as the full
 * grammar but not its per-dialect keyword tuning, which is the price of staying responsive at this size.
 */
export function createLargeDocumentSqlLanguage(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName = "mysql", databaseType?: DatabaseType, parameterOptions?: SqlParameterOptions): StreamLanguage<unknown> {
  const baseParser = largeDocumentSqlStreamParser(langSql, dialectName, databaseType);
  const mybatisEnabled = !parameterOptions?.enabledSyntaxes || parameterOptions.enabledSyntaxes.includes("mybatis");
  const parser = baseParser === mySQL && mybatisEnabled ? mysqlParameterParser : baseParser;
  let language = languageByParser.get(parser);
  if (!language) {
    language = StreamLanguage.define(parser);
    languageByParser.set(parser, language);
  }
  return language;
}
