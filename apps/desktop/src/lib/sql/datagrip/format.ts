import type { DialectOptions } from "sql-formatter/dist/esm/dialect.js";
import type { SqlFormatterParamTypes, SqlFormatterSettings } from "../sqlFormatterConfig";
import { parseDataGripAst } from "./ast";
import { buildDataGripBlockTree, countDataGripBlocks } from "./blocks";
import { printDataGripBlockTree } from "./printer";
import { resolveDataGripLayoutSettings, type DataGripDialect, type DataGripFormatResult } from "./types";

export const MAX_DATAGRIP_INPUT_CHARS = 250_000;
export const MAX_DATAGRIP_AST_NODES = 200_000;
export const MAX_DATAGRIP_BLOCK_NODES = 200_000;

export class DataGripFormatBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataGripFormatBudgetError";
  }
}

export interface DataGripFormatRequest {
  sql: string;
  dialect: DataGripDialect;
  dialectOptions: DialectOptions;
  settings: SqlFormatterSettings;
  paramTypes: SqlFormatterParamTypes | null;
}

export async function formatDataGripSql(request: DataGripFormatRequest): Promise<DataGripFormatResult> {
  if (request.sql.length > MAX_DATAGRIP_INPUT_CHARS) throw new DataGripFormatBudgetError(`DataGrip formatting is limited to ${MAX_DATAGRIP_INPUT_CHARS} characters per request.`);
  const started = performance.now();
  const ast = await parseDataGripAst(request.sql, request.dialectOptions, request.paramTypes);
  if (ast.nodeCount > MAX_DATAGRIP_AST_NODES) throw new DataGripFormatBudgetError(`DataGrip formatting is limited to ${MAX_DATAGRIP_AST_NODES} AST nodes per request.`);
  const settings = resolveDataGripLayoutSettings(request.dialect, request.settings);
  const tree = buildDataGripBlockTree(ast.statements, settings);
  const blockCount = countDataGripBlocks(tree);
  if (blockCount > MAX_DATAGRIP_BLOCK_NODES) throw new DataGripFormatBudgetError(`DataGrip formatting is limited to ${MAX_DATAGRIP_BLOCK_NODES} formatter blocks per request.`);
  const analysisMs = performance.now() - started;
  const printStarted = performance.now();
  const formatted = printDataGripBlockTree(tree, request.sql, settings);
  return {
    formatted,
    metrics: {
      astNodes: ast.nodeCount,
      blockNodes: blockCount,
      analysisMs,
      printMs: performance.now() - printStarted,
    },
  };
}
