import type { DialectOptions } from "sql-formatter/dist/esm/dialect.js";
import { createRenderers, loadEngine, type SqlFormatterEngine, type SqlFormatterParamValues } from "./internals";
import { printSqlLayout, type SqlLayoutOptions } from "./printer";

export type { SqlLayoutOptions } from "./printer";

/**
 * Default layout knobs: a 120-column hard wrap, element lists of up to three
 * kept on one line, a two-space indent, and joins indented one step below their
 * FROM clause.
 */
export const DEFAULT_SQL_LAYOUT_OPTIONS: SqlLayoutOptions = {
  lineWidth: 120,
  keepElementsOnOneLine: 3,
  indentWidth: 2,
  joinIndentWidth: 4,
  keywordCase: "preserve",
  logicalOperatorNewline: "before",
  linesBetweenQueries: 1,
  useTabs: false,
  fromClauseSourceOnSameLine: true,
};

export interface SqlLayoutRequest {
  sql: string;
  /** sql-formatter dialect key, e.g. `mysql` / `postgresql` / `plsql`. */
  language: string;
  /**
   * The dialect options to parse with, when the caller has already resolved
   * them. Parsing with anything but the caller's own dialect would make this
   * layout disagree with the statements the public formatter produces for the
   * same input — DBX's ClickHouse tweak, which keeps date-part abbreviations
   * out of the reserved list, is exactly such a case.
   */
  dialectOptions?: DialectOptions;
  /** sql-formatter `FormatOptions` (casing flags, tab width, param types, ...). */
  cfg: Record<string, unknown>;
  options?: Partial<SqlLayoutOptions>;
}

function dialectFor(engine: SqlFormatterEngine, request: SqlLayoutRequest) {
  const dialectOptions = request.dialectOptions ?? engine.dialects[request.language] ?? engine.dialects.sql;
  return engine.createDialect(dialectOptions);
}

/**
 * Formats `sql` with the default style's layout rules.
 *
 * Returns `null` when sql-formatter's internals are unavailable or the input
 * cannot be parsed, so callers can fall back to the public `format()` API
 * instead of surfacing a failure to the user.
 */
export async function formatSqlLayout(request: SqlLayoutRequest): Promise<string | null> {
  const engine = await loadEngine();
  if (!engine) return null;

  const dialect = dialectFor(engine, request);
  const options: SqlLayoutOptions = {
    ...DEFAULT_SQL_LAYOUT_OPTIONS,
    keywordCase: (request.cfg.keywordCase as SqlLayoutOptions["keywordCase"]) ?? "preserve",
    ...request.options,
  };
  // `indentStyle` selects sql-formatter's tabular layouts, which pad every clause
  // to a fixed column, and `useTabs` makes it indent with tabs. The rules here
  // replace that layout and write their own indentation, so both are pinned: the
  // renderers must emit space-indented text relative to column 0, which the
  // printer then re-bases onto the column it measured.
  // The annotation keeps the index signature spread objects would otherwise lose,
  // so `paramTypes`/`params` stay readable below.
  const cfg: Record<string, unknown> = { ...request.cfg, indentStyle: "standard", useTabs: false };

  try {
    const statements = engine.parse(request.sql, dialect, (cfg.paramTypes as Record<string, unknown>) ?? {});
    return printSqlLayout(statements, {
      renderers: createRenderers(engine, dialect, cfg, new engine.Params(cfg.params as SqlFormatterParamValues), options.indentWidth),
      options,
    });
  } catch {
    // Parse failures are the formatter's normal "not supported yet" signal; the
    // caller degrades to sql-formatter's own output or to the original text.
    return null;
  }
}
