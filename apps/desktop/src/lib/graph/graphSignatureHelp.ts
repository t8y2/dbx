import type { SqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";
import { graphFunctionDefinition, type GraphFunctionDefinition } from "./graphQueryFunctions";
import { graphQueryTokens, type GraphQueryDatabase } from "./graphQueryLanguage";
import { graphIdentifier } from "./graphCompletionScope";

export function getGraphFunctionSignatureHelp(text: string, cursor: number, databaseType: GraphQueryDatabase, options?: { truncatedPrefix?: boolean }): SqlFunctionSignatureHelp | null {
  const source = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const tokens = graphQueryTokens(source, databaseType);
  const last = tokens[tokens.length - 1];
  if (last && ((last.kind === "string" && last.open) || (last.kind === "comment" && (last.open || (!last.text.startsWith("/*") && !/[\r\n]/.test(source.slice(last.to))))))) return null;

  const stack: Array<{ delimiter: string; definition?: GraphFunctionDefinition; argument: number; name?: string; openTo: number }> = [];
  const significant = tokens.filter((token) => token.kind !== "comment");
  for (let index = 0; index < significant.length; index++) {
    const token = significant[index]!;
    if (token.kind === "string" || token.kind === "identifier") continue;
    if (token.text === ";") stack.length = 0;
    else if (["(", "[", "{"].includes(token.text)) {
      const parts: string[] = [];
      let nameFrom = token.from;
      let start = index - 1;
      while (start >= 0) {
        const name = graphIdentifier(significant[start]);
        if (!name) break;
        nameFrom = significant[start]!.from;
        parts.unshift(name);
        if (significant[start - 1]?.text !== ".") break;
        start -= 2;
      }
      const name = parts.join(".");
      const callTarget = significant[start - 1]?.text.toUpperCase() === "CALL";
      const definition = token.text === "(" && !callTarget && significant[start - 1]?.text !== ":" && (!options?.truncatedPrefix || nameFrom > 0) ? graphFunctionDefinition(name, databaseType) : undefined;
      stack.push({ delimiter: token.text, definition, name, argument: 0, openTo: token.to });
    } else if ([")", "]", "}"].includes(token.text)) {
      const expected = { ")": "(", "]": "[", "}": "{" }[token.text];
      if (stack[stack.length - 1]?.delimiter !== expected) stack.length = 0;
      else stack.pop();
    } else if (token.text === "," && stack.length) stack[stack.length - 1]!.argument++;
  }
  const frame = [...stack].reverse().find((frame) => frame.definition);
  if (!frame?.definition || !frame.name) return null;
  const definition = frame.definition;
  const groups = definition.overloads ?? [definition.parameters];
  const hasArgument = (significant[significant.length - 1]?.to ?? 0) > frame.openTo;
  const matchingOverload = hasArgument ? groups.findIndex((group) => group.length > frame.argument) : 0;
  const activeOverload = Math.max(0, matchingOverload);
  const parameters = [...groups[activeOverload]!];
  const activeParameter = parameters.length ? Math.min(frame.argument, parameters.length - 1) : -1;
  return {
    name: frame.name,
    parameters,
    activeParameter,
    signature: `${frame.name}(${parameters.join(", ")})`,
    activeOverload,
    overloads: groups.map((group) => ({
      signature: `${frame.name}(${group.join(", ")})`,
      parameterGroups: [[...group]],
      activeGroup: 0,
      activeParameter: group.length ? Math.min(frame.argument, group.length - 1) : -1,
    })),
  };
}
