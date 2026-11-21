import type { Dialect, DialectOptions } from "sql-formatter/dist/esm/dialect.js";
import type { StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import type { SqlFormatterParamTypes } from "../sqlFormatterConfig";

export interface DataGripAst {
  statements: StatementNode[];
  nodeCount: number;
}

let parserModulePromise: Promise<typeof import("sql-formatter/dist/esm/parser/createParser.js")> | null = null;
let dialectModulePromise: Promise<typeof import("sql-formatter/dist/esm/dialect.js")> | null = null;

async function parserModule() {
  parserModulePromise ??= import("sql-formatter/dist/esm/parser/createParser.js");
  return parserModulePromise;
}

async function dialectModule() {
  dialectModulePromise ??= import("sql-formatter/dist/esm/dialect.js");
  return dialectModulePromise;
}

export async function parseDataGripAst(sql: string, dialectOptions: DialectOptions, paramTypes: SqlFormatterParamTypes | null): Promise<DataGripAst> {
  const [{ createParser }, { createDialect }] = await Promise.all([parserModule(), dialectModule()]);
  const dialect: Dialect = createDialect(dialectOptions);
  const statements = createParser(dialect.tokenizer).parse(sql, (paramTypes ?? {}) as Record<string, unknown>);
  return { statements, nodeCount: countAstNodes(statements) };
}

function countAstNodes(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAstNodes(item), 0);
  const record = value as Record<string, unknown>;
  let count = typeof record.type === "string" ? 1 : 0;
  for (const [key, child] of Object.entries(record)) {
    if (key === "leadingComments" || key === "trailingComments" || key === "precedingWhitespace") continue;
    count += countAstNodes(child);
  }
  return count;
}
