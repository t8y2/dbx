import type { AstNode, ClauseNode } from "sql-formatter/dist/esm/parser/ast.js";
import type { SqlLayoutContext } from "./primitives";
import type { SqlFormatterCommaPosition, SqlFormatterListLayout, SqlFormatterLogicalOperatorNewline } from "../sqlFormatterConfig";

export function clauseRuleContext(ctx: SqlLayoutContext, clause: ClauseNode): SqlLayoutContext {
  if (!ctx.options.rules) return ctx;
  const keyword = clause.nameKw.text.toUpperCase();
  const listKind = /^SELECT(?:\s|$)/.test(keyword) ? "select" : /^(?:INSERT\b|VALUES$)/.test(keyword) ? "insert" : keyword === "SET" || keyword === "UPDATE SET" ? "update" : "general";
  const definition = /^(?:INSERT\b.*\bINTO|CREATE\b.*\bTABLE)$/.test(keyword) ? clause.children.find((node) => node.type === "parenthesis") : undefined;
  return { ...ctx, listKind, logicalContext: keyword === "WHERE" ? "where" : "expression", ...(definition ? { nonCallParens: new Set([...(ctx.nonCallParens ?? []), definition]) } : {}) };
}

export function ruleListLayout(ctx: SqlLayoutContext): SqlFormatterListLayout {
  const rules = ctx.options.rules!;
  const override = ctx.listKind === "select" ? rules.selectListLayout : ctx.listKind === "insert" ? rules.insertListLayout : ctx.listKind === "update" ? rules.updateListLayout : "inherit";
  return override === "inherit" ? rules.listLayout : override;
}

export function ruleCommaPosition(ctx: SqlLayoutContext): SqlFormatterCommaPosition {
  const rules = ctx.options.rules!;
  const override = ctx.listKind === "select" ? rules.selectCommaPosition : ctx.listKind === "insert" ? rules.insertCommaPosition : ctx.listKind === "update" ? rules.updateCommaPosition : "inherit";
  return override === "inherit" ? rules.commaPosition : override;
}

export function ruleLogicalNewline(ctx: SqlLayoutContext): SqlFormatterLogicalOperatorNewline {
  const rules = ctx.options.rules;
  if (!rules) return ctx.options.logicalOperatorNewline;
  const override = ctx.logicalContext === "where" ? rules.whereLogicalOperatorNewline : ctx.logicalContext === "on" ? rules.onLogicalOperatorNewline : rules.expressionLogicalOperatorNewline;
  return override === "inherit" ? rules.logicalOperatorNewline : override;
}

function logicalOperator(node: AstNode): boolean {
  return node.type === "keyword" && ["AND", "OR", "XOR"].includes(node.tokenType);
}

/** Before measuring any container, honour rules its nested SQL would otherwise bypass. */
export function hasRuleLineBreak(ctx: SqlLayoutContext, nodes: AstNode[]): boolean {
  if (!ctx.options.rules) return false;
  if (ruleListLayout(ctx) === "vertical" && nodes.some((node) => node.type === "comma")) return true;
  if (ruleLogicalNewline(ctx) !== "none" && nodes.some(logicalOperator)) return true;
  return nodes.some((node, index) => {
    if (node.leadingComments?.length || node.trailingComments?.length) return true;
    switch (node.type) {
      case "line_comment":
      case "block_comment":
      case "disable_comment":
        return true;
      case "clause":
        return hasRuleLineBreak(clauseRuleContext(ctx, node), node.children);
      case "set_operation":
        return hasRuleLineBreak(ctx, node.children);
      case "parenthesis": {
        const previous = nodes[index - 1];
        const call = !ctx.nonCallParens?.has(node) && (previous?.type === "identifier" || previous?.type === "property_access");
        return hasRuleLineBreak(call ? { ...ctx, listKind: "general" } : ctx, node.children);
      }
      case "function_call":
      case "parameterized_data_type":
      case "array_subscript":
        return hasRuleLineBreak({ ...ctx, listKind: "general" }, node.parenthesis.children);
      case "property_access":
        return hasRuleLineBreak(ctx, [node.object, node.property]);
      case "between_predicate":
        return hasRuleLineBreak(ctx, [...node.expr1, ...node.expr2]);
      case "case_expression":
        return hasRuleLineBreak({ ...ctx, listKind: "general", logicalContext: "expression" }, [...node.expr, ...node.clauses]);
      case "case_when":
        return hasRuleLineBreak(ctx, [...node.condition, ...node.result]);
      case "case_else":
        return hasRuleLineBreak(ctx, node.result);
      case "limit_clause":
        return hasRuleLineBreak(ctx, [...(node.offset ?? []), ...node.count]);
      case "keyword":
        return ctx.options.rules!.newlineBeforeJoinOn && node.text.toUpperCase() === "ON";
      default:
        return false;
    }
  });
}

/** A parsed procedure is not a supported SQL rule model merely because it contains SELECT. */
export function supportsSqlRules(nodes: AstNode[]): boolean {
  return nodes.every((node) => {
    if (node.type === "clause" && /^(?:BEGIN|DECLARE|EXCEPTION|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|PACKAGE|TRIGGER))\b/i.test(node.nameKw.text)) return false;
    if (node.type === "operator" && node.text === ":=") return false;
    if (node.type === "keyword" && ["END", "LOOP", "ELSIF"].includes(node.tokenType)) return false;
    if (node.type === "clause" || node.type === "set_operation" || node.type === "parenthesis") return supportsSqlRules(node.children);
    return true;
  });
}
