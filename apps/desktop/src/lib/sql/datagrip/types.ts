import type { AstNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import type { SqlFormatterSettings } from "../sqlFormatterConfig";

export type DataGripDialect = "postgres" | "mysql" | "sqlite";
export type DataGripBlockKind = "root" | "statement" | "section" | "list" | "expression" | "leaf";
export type DataGripBlockRole = "none" | "prefix" | "element" | "delimiter" | "amendment" | "comment" | "error";
export type DataGripBlockShape = "undecided" | "decideLater" | "oneRow" | "multiRows";
export type DataGripWrap = "none" | "normal" | "chopIfLong" | "always";

export interface DataGripLayoutSettings {
  dialect: DataGripDialect;
  lineWidth: number;
  indentWidth: number;
  continuationIndentWidth: number;
  useTabs: boolean;
  keywordCase: SqlFormatterSettings["keywordCase"];
  dataTypeCase: SqlFormatterSettings["dataTypeCase"];
  functionCase: SqlFormatterSettings["functionCase"];
  identifierCase: SqlFormatterSettings["identifierCase"];
  commaPosition: SqlFormatterSettings["commaPosition"];
  logicalOperatorNewline: SqlFormatterSettings["logicalOperatorNewline"];
  linesBetweenQueries: SqlFormatterSettings["linesBetweenQueries"];
  preserveEmptyLines: boolean;
  denseOperators: boolean;
  newlineBeforeSemicolon: boolean;
  fromClauseLayout: SqlFormatterSettings["fromClauseLayout"];
  selectListLayout: SqlFormatterSettings["selectListLayout"];
  insertListLayout: SqlFormatterSettings["insertListLayout"];
  updateListLayout: SqlFormatterSettings["updateListLayout"];
  listLayout: SqlFormatterSettings["listLayout"];
  listItemAlignment: SqlFormatterSettings["listItemAlignment"];
  alignSelectAliases: boolean;
  alignUpdateAssignments: boolean;
  newlineBeforeJoinOn: boolean;
  collapseShortStatements: boolean;
  customRulesEnabled: boolean;
  emptyLineMode: SqlFormatterSettings["emptyLineMode"];
}

export interface DataGripBlock {
  id: number;
  kind: DataGripBlockKind;
  role: DataGripBlockRole;
  shape: DataGripBlockShape;
  wrap: DataGripWrap;
  indent: number;
  align: number | null;
  minLength: number;
  hasUserBreaks: boolean;
  flatText: string;
  ast?: AstNode | StatementNode;
  section?: string;
  children: DataGripBlock[];
}

export interface DataGripRoot extends DataGripBlock {
  kind: "root";
  statements: StatementNode[];
}

export interface DataGripFormatMetrics {
  astNodes: number;
  blockNodes: number;
  analysisMs: number;
  printMs: number;
}

export interface DataGripFormatResult {
  formatted: string;
  metrics: DataGripFormatMetrics;
}

export function resolveDataGripLayoutSettings(dialect: DataGripDialect, settings: SqlFormatterSettings): DataGripLayoutSettings {
  return {
    dialect,
    lineWidth: settings.expressionWidth,
    indentWidth: settings.tabWidth,
    continuationIndentWidth: Math.max(2, Math.floor(settings.tabWidth / 2)),
    useTabs: settings.useTabs,
    keywordCase: settings.keywordCase,
    dataTypeCase: settings.dataTypeCase,
    functionCase: settings.functionCase,
    identifierCase: settings.identifierCase,
    commaPosition: settings.commaPosition,
    logicalOperatorNewline: settings.logicalOperatorNewline,
    linesBetweenQueries: settings.linesBetweenQueries,
    preserveEmptyLines: settings.preserveEmptyLines,
    denseOperators: settings.denseOperators,
    newlineBeforeSemicolon: settings.newlineBeforeSemicolon,
    fromClauseLayout: settings.fromClauseLayout,
    selectListLayout: settings.selectListLayout,
    insertListLayout: settings.insertListLayout,
    updateListLayout: settings.updateListLayout,
    listLayout: settings.listLayout,
    listItemAlignment: settings.listItemAlignment,
    alignSelectAliases: settings.alignSelectAliases,
    alignUpdateAssignments: settings.alignUpdateAssignments,
    newlineBeforeJoinOn: settings.newlineBeforeJoinOn,
    collapseShortStatements: settings.collapseShortStatements,
    customRulesEnabled: settings.customRulesEnabled,
    emptyLineMode: settings.emptyLineMode,
  };
}
