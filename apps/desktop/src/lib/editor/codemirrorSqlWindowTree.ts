import type { SQLDialect } from "@codemirror/lang-sql";

// `@lezer/common` is only a transitive dependency; derive the tree type from CodeMirror instead.
export type SqlWindowTree = ReturnType<typeof import("@codemirror/language").syntaxTree>;

interface SqlWindowParserSource {
  /** Identifies the dialect; parsers are rebuilt only when it changes. */
  key: () => string;
  dialect: () => SQLDialect;
}

/**
 * Parses one bounded piece of SQL (a statement or a viewport window) with the full Lezer grammar.
 *
 * The editor itself stops running that grammar over documents past the syntax budget because it has
 * to parse everything before the viewport. The features that still want exact structure (block
 * folding, table-name colouring) only ever look at one statement, so they parse just that text here.
 */
export function createSqlWindowTreeParser(langSql: Pick<typeof import("@codemirror/lang-sql"), "sql">, source: SqlWindowParserSource): (text: string) => SqlWindowTree {
  const parsers = new Map<string, { parse(text: string): SqlWindowTree }>();
  return (text) => {
    const key = source.key();
    let parser = parsers.get(key);
    if (!parser) {
      parser = langSql.sql({ dialect: source.dialect() }).language.parser as unknown as { parse(text: string): SqlWindowTree };
      parsers.set(key, parser);
    }
    return parser.parse(text);
  };
}
