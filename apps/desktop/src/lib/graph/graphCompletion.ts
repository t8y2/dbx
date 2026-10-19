import type { SqlCompletionColumn, SqlCompletionItem, SqlCompletionTable, SqlKeywordCase } from "@/lib/sql/sqlCompletion";
import type { SqlSnippet } from "@/types/database";
import { graphFunctionDefinitions } from "./graphQueryFunctions";
import { graphQueryKeywords, graphQueryTokens, type GraphQueryDatabase } from "./graphQueryLanguage";
import { graphQueryProfile } from "./graphQueryProfiles";
import { graphCompletionScope, graphIdentifier as identifier } from "./graphCompletionScope";

export interface GraphCompletionContext {
  mode: "none" | "expression" | "label" | "relationship" | "object" | "property" | "database" | "function";
  from: number;
  to: number;
  prefix: string;
  quoted: boolean;
  openingParenAfterCursor?: boolean;
  replaceClosingQuote?: "`";
  objects: string[];
  variables: string[];
  functionNamespace?: string;
  localProperties?: string[];
  propertyMap?: boolean;
}

export function getGraphCompletionContext(text: string, cursor: number, databaseType: GraphQueryDatabase): GraphCompletionContext {
  const position = Math.max(0, Math.min(cursor, text.length));
  const source = text.slice(0, position);
  const tokens = graphQueryTokens(source, databaseType);
  const last = tokens[tokens.length - 1];
  const result: GraphCompletionContext = { mode: "expression", from: position, to: position, prefix: "", quoted: false, objects: [], variables: [] };
  if (last && ((last.kind === "string" && last.open) || (last.kind === "comment" && (last.open || (!last.text.startsWith("/*") && !/[\r\n]/.test(source.slice(last.to))))))) return { ...result, mode: "none" };
  const atIdentifier = last?.to === position && identifier(last) !== undefined;
  if (last && atIdentifier) {
    result.from = last.from;
    result.prefix = identifier(last)!;
    result.quoted = last.text.startsWith("`");
    if (result.quoted) {
      result.from++;
      if (last.open) result.to += /^(?:[^`]|``)*/.exec(text.slice(position))?.[0].length ?? 0;
      if (text[result.to] === "`") result.replaceClosingQuote = "`";
    }
    if (!result.quoted) result.to += /^[\p{L}\p{N}_$]*/u.exec(text.slice(position))?.[0].length ?? 0;
    tokens.pop();
  }
  let statementStart = tokens.length - 1;
  while (statementStart >= 0 && tokens[statementStart]?.text !== ";") statementStart--;
  const before = tokens.slice(statementStart + 1).filter((token) => token.kind !== "comment");
  const { bindings, pipelineFields, propertyMapObjects } = graphCompletionScope(before);
  result.variables = [...bindings.keys()];
  const tail = before[before.length - 1];
  const previous = before[before.length - 2];
  if (tail?.text === ".") {
    const qualifier = identifier(previous);
    result.mode = "property";
    result.objects = qualifier ? (bindings.get(qualifier)?.objects ?? (databaseType === "nebula" ? [qualifier] : [])) : [];
    const parts: string[] = [];
    for (let index = before.length - 2; index >= 0; index -= 2) {
      const name = identifier(before[index]);
      if (!name) break;
      parts.unshift(name);
      if (before[index - 1]?.text !== ".") break;
    }
    const namespace = parts.join(".");
    if (!bindings.has(parts[0] ?? "") && graphFunctionDefinitions(databaseType).some((definition) => definition.name.toLowerCase().startsWith(`${namespace.toLowerCase()}.`))) {
      result.mode = "function";
      result.functionNamespace = namespace;
      result.objects = [];
    }
    // nGQL qualifies node properties with a tag: v.player.name.
    if (databaseType === "nebula") {
      if (before[before.length - 3]?.text === "." && qualifier) result.objects = [qualifier];
      else if ((qualifier && bindings.has(qualifier) && !bindings.get(qualifier)?.relationship) || qualifier === "$$" || previous?.text === "^") result.mode = "label";
      if (previous?.text === "-" && before[before.length - 3]?.text === "$") {
        result.mode = "property";
        result.objects = [];
        result.localProperties = pipelineFields;
      }
    }
  } else if (tail?.text === ":") {
    const stack: string[] = [];
    for (const token of before) {
      if (["(", "[", "{"].includes(token.text)) stack.push(token.text);
      else if ([")", "]", "}"].includes(token.text)) stack.pop();
    }
    result.mode = stack[stack.length - 1] === "[" ? "relationship" : stack[stack.length - 1] === "(" ? "label" : "none";
  } else if (databaseType === "nebula") {
    const words = before.map((token) => token.text.toUpperCase());
    if (tail?.text.toUpperCase() === "USE") result.mode = "database";
    else if (tail?.text.toUpperCase() === "OVER" || ["EDGE", "EDGES"].includes(words[words.length - 1] ?? "")) result.mode = "relationship";
    else if (["TAG", "TAGS", "VERTEX"].includes(words[words.length - 1] ?? "")) result.mode = "label";
    else if (tail?.text.toUpperCase() === "ON" && ["LOOKUP", "FETCH"].some((word) => words.includes(word))) result.mode = "object";
    else if (tail?.text === ",") {
      for (let index = before.length - 2; index >= 0; index--) {
        const word = before[index]!.text.toUpperCase();
        if (["YIELD", "WHERE", "RETURN", "|", ";"].includes(word)) break;
        if (word === "OVER") {
          result.mode = "relationship";
          break;
        }
      }
    }
  }
  if (propertyMapObjects !== undefined) {
    result.mode = "property";
    result.objects = propertyMapObjects;
    result.propertyMap = true;
  }
  let callIndex = -1;
  for (let index = before.length - 1; index >= 0; index--) {
    if (before[index]?.kind !== "keyword") continue;
    const word = before[index]!.text.toUpperCase();
    if (word === "CALL") {
      callIndex = index;
      break;
    }
    if (["RETURN", "WITH", "YIELD", "MATCH", "WHERE"].includes(word)) break;
  }
  if (callIndex >= 0 && before.slice(callIndex + 1).every((token) => identifier(token) !== undefined || token.text === ".")) result.mode = "none";
  if (result.quoted && result.mode === "expression") result.mode = "none";
  result.openingParenAfterCursor = /^\s*\(/.test(text.slice(result.to));
  return result;
}

export function shouldAutoOpenGraphCompletion(text: string, cursor: number, databaseType: GraphQueryDatabase): boolean {
  const context = getGraphCompletionContext(text, cursor, databaseType);
  return context.mode !== "none" && (!!context.prefix || context.mode !== "expression");
}

export function graphCompletionValidFor(context: GraphCompletionContext): RegExp {
  return context.quoted ? /^(?:[^`]|``)*$/ : /^[\p{L}\p{N}_$]*$/u;
}

export interface GraphCompletionOptions {
  keywordCase?: SqlKeywordCase;
  functionCase?: SqlKeywordCase;
  functionCompletionIncludeParams?: boolean;
  snippets?: SqlSnippet[];
}

function applyCase(value: string, letterCase?: SqlKeywordCase): string {
  return letterCase === "lower" ? value.toLowerCase() : letterCase === "upper" ? value.toUpperCase() : value;
}

export function buildGraphCompletionItems(context: GraphCompletionContext, databaseType: GraphQueryDatabase, metadata: { tables?: SqlCompletionTable[]; columns?: SqlCompletionColumn[]; databases?: string[] } = {}, options: GraphCompletionOptions = {}): SqlCompletionItem[] {
  if (context.mode === "none") return [];
  const profile = graphQueryProfile(databaseType);
  const language = profile.language;
  const reserved = new Set(profile.reservedWords);
  const quote = (name: string) => (context.quoted ? `${name.replaceAll("`", "``")}\`` : !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || reserved.has(name.toUpperCase()) ? `\`${name.replaceAll("`", "``")}\`` : name);
  const nameItem = (name: string, type: "table" | "column" | "schema" | "variable", detail: string): SqlCompletionItem => ({ label: name, type, detail, apply: quote(name), boost: 100, ...(context.replaceClosingQuote ? { replaceClosingQuote: context.replaceClosingQuote } : {}) });
  let items: SqlCompletionItem[];
  if (context.mode === "database") items = (metadata.databases ?? []).map((name) => nameItem(name, "schema", "nGQL space"));
  else if (context.mode === "property") items = [...(metadata.columns ?? []).map((column) => nameItem(column.name, "column", [column.table, column.dataType].filter(Boolean).join(" - "))), ...(context.localProperties ?? []).map((name) => nameItem(name, "column", "nGQL pipeline column"))];
  else if (["label", "relationship", "object"].includes(context.mode)) {
    items = (metadata.tables ?? [])
      .filter((table) => {
        // Neo4j's existing table metadata contains node labels, not relationship types.
        if (databaseType === "neo4j") return context.mode !== "relationship";
        return context.mode === "object" || (context.mode === "relationship" ? table.type === "view" : table.type !== "view");
      })
      .map((table) => nameItem(table.name, "table", databaseType === "neo4j" ? "Cypher label" : table.type === "view" ? "nGQL edge" : "nGQL tag"));
  } else {
    items = [
      ...(context.mode === "function" ? [] : graphQueryKeywords(databaseType).map((word): SqlCompletionItem => ({ label: applyCase(word, options.keywordCase), type: "keyword", detail: language, boost: 40 }))),
      ...graphFunctionDefinitions(databaseType)
        .filter((definition) => !context.functionNamespace || definition.name.toLowerCase().startsWith(`${context.functionNamespace.toLowerCase()}.`))
        .map((definition): SqlCompletionItem => {
          const label = applyCase(context.functionNamespace ? definition.name.slice(context.functionNamespace.length + 1) : definition.name, options.functionCase);
          const required = definition.parameters.filter((parameter) => !parameter.endsWith("?") && !parameter.startsWith("..."));
          const template = definition.template?.replace(/\b(IN|WHERE)\b/g, (word) => applyCase(word, options.keywordCase));
          const parameters = options.functionCompletionIncludeParams === false ? (definition.parameters.length ? "${}" : "") : (template ?? required.map((parameter) => `\${${parameter}}`).join(", "));
          return { label, type: "function", detail: `${language} - ${label}(${definition.parameters.join(", ")})`, apply: context.openingParenAfterCursor ? label : `${label}(${parameters})`, boost: 30 };
        }),
      ...(context.mode === "function" ? [] : context.variables.map((name) => nameItem(name, "variable", `${language} variable`))),
    ];
    if (context.prefix) {
      for (const snippet of options.snippets ?? []) {
        // SQL built-ins are not valid graph query templates; user snippets retain their exact text.
        if (snippet.enabled === false || snippet.id.startsWith("builtin-")) continue;
        if (!snippet.prefix.toLowerCase().startsWith(context.prefix.toLowerCase())) continue;
        items.push({ label: snippet.label, filterText: snippet.prefix, type: "snippet", apply: snippet.body, detail: snippet.body, exactMatch: snippet.prefix.toLowerCase() === context.prefix.toLowerCase() || undefined, boost: 4000 });
      }
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.label}`;
    if (seen.has(key) || !(item.filterText ?? item.label).toLowerCase().startsWith(context.prefix.toLowerCase())) return false;
    seen.add(key);
    return true;
  });
}
