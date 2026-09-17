import type { Dialect, DialectOptions } from "sql-formatter/dist/esm/dialect.js";
import type ExpressionFormatter from "sql-formatter/dist/esm/formatter/ExpressionFormatter.js";
import type Indentation from "sql-formatter/dist/esm/formatter/Indentation.js";
import type InlineLayout from "sql-formatter/dist/esm/formatter/InlineLayout.js";
import type Layout from "sql-formatter/dist/esm/formatter/Layout.js";
import type Params from "sql-formatter/dist/esm/formatter/Params.js";
import type { AstNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";

/**
 * Access to sql-formatter's bundled parser and layout machinery.
 *
 * sql-formatter's public surface is `format()` / `formatDialect()`, and its
 * output layout is not configurable enough for the default style DBX targets:
 * clause keywords must sit flush left, a clause's continuation lines align under
 * its first item, and parenthesized groups stay inline while they fit. All of
 * that needs the AST plus the "measure, don't wrap" layout the package only
 * ships internally, so these imports go through the `sql-formatter/dist/` alias
 * set up in vite.config.ts and vitest.config.ts.
 *
 * This module is the single place that reaches into the package internals. If a
 * dependency bump ever breaks one of these shapes, `loadEngine()` reports that
 * and every caller falls back to the public `format()` API rather than throwing.
 */

type InlineLayoutCtor = typeof InlineLayout;
type InlineLayoutErrorCtor = typeof import("sql-formatter/dist/esm/formatter/InlineLayout.js").InlineLayoutError;
type ExpressionFormatterCtor = typeof ExpressionFormatter;
type ParamsCtor = typeof Params;
type LayoutCtor = typeof Layout;
type IndentationCtor = typeof Indentation;

/**
 * The values `Params` resolves placeholders against, as sql-formatter types them:
 * `cfg.params`, which DBX never sets — the config importer rejects that legacy
 * key — so placeholders keep their literal text in the output.
 */
export type SqlFormatterParamValues = ConstructorParameters<ParamsCtor>[0];

/** The subset of sql-formatter's internals the layout printer needs. */
export interface SqlFormatterEngine {
  /** Every bundled dialect, keyed by the name `format()` accepts. */
  readonly dialects: Record<string, DialectOptions>;
  readonly createDialect: (options: DialectOptions) => Dialect;
  readonly parse: (sql: string, dialect: Dialect, paramTypes: Record<string, unknown>) => StatementNode[];
  readonly ExpressionFormatter: ExpressionFormatterCtor;
  readonly InlineLayout: InlineLayoutCtor;
  readonly InlineLayoutError: InlineLayoutErrorCtor;
  readonly Params: ParamsCtor;
  readonly Layout: LayoutCtor;
  readonly Indentation: IndentationCtor;
}

let enginePromise: Promise<SqlFormatterEngine | null> | null = null;

async function importEngine(): Promise<SqlFormatterEngine | null> {
  try {
    // Literal specifiers only: Vite cannot statically analyse a computed path,
    // and these must resolve through the `sql-formatter/dist/` alias.
    const [parserMod, dialectMod, allDialects, expressionMod, inlineLayoutMod, paramsMod, layoutMod, indentationMod] = await Promise.all([
      import("sql-formatter/dist/esm/parser/createParser.js"),
      import("sql-formatter/dist/esm/dialect.js"),
      import("sql-formatter/dist/esm/allDialects.js"),
      import("sql-formatter/dist/esm/formatter/ExpressionFormatter.js"),
      import("sql-formatter/dist/esm/formatter/InlineLayout.js"),
      import("sql-formatter/dist/esm/formatter/Params.js"),
      import("sql-formatter/dist/esm/formatter/Layout.js"),
      import("sql-formatter/dist/esm/formatter/Indentation.js"),
    ]);

    const createParser = parserMod.createParser;
    const createDialect = dialectMod.createDialect;
    const ExpressionFormatter = expressionMod.default;
    const InlineLayout = inlineLayoutMod.default;
    const InlineLayoutError = inlineLayoutMod.InlineLayoutError;
    const Params = paramsMod.default;
    const Layout = layoutMod.default;
    const Indentation = indentationMod.default;

    if (
      typeof createParser !== "function" ||
      typeof createDialect !== "function" ||
      typeof ExpressionFormatter !== "function" ||
      typeof InlineLayout !== "function" ||
      typeof InlineLayoutError !== "function" ||
      typeof Params !== "function" ||
      typeof Layout !== "function" ||
      typeof Indentation !== "function" ||
      !allDialects ||
      typeof allDialects !== "object"
    ) {
      return null;
    }

    return {
      dialects: allDialects as unknown as Record<string, DialectOptions>,
      createDialect,
      parse: (sql, dialect, paramTypes) => createParser(dialect.tokenizer).parse(sql, paramTypes),
      ExpressionFormatter,
      InlineLayout,
      InlineLayoutError,
      Params,
      Layout,
      Indentation,
    };
  } catch {
    // Older/newer sql-formatter layouts move these files around. Report "no
    // engine" so the caller uses the public formatter instead of failing the
    // user's format action outright.
    return null;
  }
}

/** Loads (and caches) the engine, or `null` when the internals are unavailable. */
export function loadEngine(): Promise<SqlFormatterEngine | null> {
  enginePromise ??= importEngine();
  return enginePromise;
}

/**
 * The two rendering primitives the layout printer builds on.
 *
 * Both render *relative to column 0*; positioning is the printer's job, which is
 * what lets it align clause items under a column that depends on the enclosing
 * `(` rather than on a fixed indent level.
 */
export interface SqlLayoutRenderers {
  /** Renders `nodes` on a single line, or `null` when they do not fit `width`. */
  inline(nodes: AstNode[], width: number): string | null;
  /** Renders `nodes` on one or more lines, indented relative to column 0. */
  block(nodes: AstNode[]): string;
  /**
   * Whether the dialect writes `text` without a space in front of it.
   *
   * The printer renders a parenthesis group and its surroundings in separate
   * steps, so it decides the separating space itself and has to agree with the
   * renderer: sql-formatter drops the space for a "dense" operator such as
   * PostgreSQL's `::`, and `cfg.denseOperators` makes every operator dense.
   */
  denseOperator(text: string): boolean;
}

/**
 * Measures `nodes` with sql-formatter's `InlineLayout`, returning `null` instead
 * of throwing when the group cannot be a single line.
 *
 * `InlineLayout` raises for both reasons we care about — a construct that
 * genuinely requires a line break (a clause, a `--` comment) and text that would
 * overflow `width` — so one call answers "would this fit on the line?" exactly,
 * which is what the collapse rule is decided on.
 */
export function renderInline(engine: SqlFormatterEngine, nodes: AstNode[], dialect: Dialect, cfg: Record<string, unknown>, params: InstanceType<ParamsCtor>, width: number): string | null {
  if (nodes.length === 0 || width <= 0) return null;

  // `formatParenthesis` measures nested groups against `cfg.expressionWidth`, so
  // point it at the width available here. Rendering is synchronous, and the
  // previous value is restored below.
  const previousWidth = cfg.expressionWidth;
  cfg.expressionWidth = width;
  try {
    const formatter = new engine.ExpressionFormatter({
      cfg: cfg as never,
      dialectCfg: dialect.formatOptions,
      params: params as never,
      layout: new engine.InlineLayout(width) as never,
      inline: true,
    });
    // No whitespace collapsing here: an inline layout never emits a newline (it
    // raises first) and squashing runs of spaces would corrupt string literals.
    const text = formatter.format(nodes).toString().trim();
    return text || null;
  } catch (error) {
    if (error instanceof engine.InlineLayoutError) return null;
    throw error;
  } finally {
    cfg.expressionWidth = previousWidth;
  }
}

/** Creates the inline/block renderer pair for one dialect and configuration. */
export function createRenderers(engine: SqlFormatterEngine, dialect: Dialect, cfg: Record<string, unknown>, params: InstanceType<ParamsCtor>, indentWidth: number): SqlLayoutRenderers {
  const indent = " ".repeat(Math.max(1, indentWidth));
  const alwaysDenseOperators = dialect.formatOptions.alwaysDenseOperators ?? [];
  return {
    inline: (nodes, width) => renderInline(engine, nodes, dialect, cfg, params, width),
    block: (nodes) => {
      const layout = new engine.Layout(new engine.Indentation(indent));
      const formatter = new engine.ExpressionFormatter({
        cfg: cfg as never,
        dialectCfg: dialect.formatOptions,
        params: params as never,
        layout: layout as never,
        inline: false,
      });
      return formatter.format(nodes).toString();
    },
    denseOperator: (text) => cfg.denseOperators === true || alwaysDenseOperators.includes(text),
  };
}
