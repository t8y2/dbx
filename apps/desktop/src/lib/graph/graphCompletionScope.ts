import type { GraphQueryToken } from "./graphQueryLanguage";

export interface GraphCompletionBinding {
  objects: string[];
  relationship: boolean;
}

export function graphIdentifier(token: GraphQueryToken | undefined): string | undefined {
  if (!token || !["variable", "identifier", "builtin", "keyword"].includes(token.kind ?? "")) return undefined;
  if (token.text.startsWith("`")) return token.text.slice(1, token.open ? undefined : -1).replaceAll("``", "`");
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(token.text) ? token.text : undefined;
}

const CLAUSES = new Set(["MATCH", "CREATE", "MERGE", "WHERE", "WITH", "RETURN", "UNWIND", "CALL", "YIELD", "ORDER", "SKIP", "LIMIT", "SET", "REMOVE", "DELETE", "UNION", "GO", "LOOKUP", "FETCH"]);
const emptyBinding = (): GraphCompletionBinding => ({ objects: [], relationship: false });

function projections(tokens: GraphQueryToken[], bindings: Map<string, GraphCompletionBinding>) {
  const output = new Map<string, GraphCompletionBinding>();
  let depth = 0;
  let start = 0;
  const add = (part: GraphQueryToken[]) => {
    if (part[0]?.text.toUpperCase() === "DISTINCT") part = part.slice(1);
    if (part.length === 1 && part[0]?.text === "*") for (const [name, binding] of bindings) output.set(name, binding);
    const alias = part.findIndex((token) => token.kind === "keyword" && token.text.toUpperCase() === "AS");
    const name = graphIdentifier(alias >= 0 ? part[alias + 1] : part.length === 1 ? part[0] : undefined);
    if (!name) return;
    const source = alias === 1 || part.length === 1 ? graphIdentifier(part[0]) : undefined;
    output.set(name, source ? (bindings.get(source) ?? emptyBinding()) : emptyBinding());
  };
  for (let index = 0; index <= tokens.length; index++) {
    const text = tokens[index]?.text;
    if (index === tokens.length || (text === "," && depth === 0)) {
      add(tokens.slice(start, index));
      start = index + 1;
    } else if (["(", "[", "{"].includes(text ?? "")) depth++;
    else if ([")", "]", "}"].includes(text ?? "")) depth--;
  }
  return output;
}

export function graphCompletionScope(tokens: GraphQueryToken[]) {
  let bindings = new Map<string, GraphCompletionBinding>();
  let clause = "";
  let projection: { kind: string; start: number } | undefined;
  let pipelineFields: string[] = [];
  const stack: Array<{ delimiter: string; kind?: "node" | "relationship" | "properties"; objects: string[] }> = [];

  // Use the native lexer's complete tokens; punctuation inside strings/comments never changes scope.
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "string" || token.kind === "comment") continue;
    const word = token.text.toUpperCase();
    const previous = tokens[index - 1];
    if (stack.length === 0 && previous?.text !== "." && token.kind === "keyword" && CLAUSES.has(word)) {
      if (projection) {
        const projected = projections(tokens.slice(projection.start, index), bindings);
        if (projection.kind === "WITH") bindings = projected;
        projection = undefined;
      }
      if (word === "UNION") bindings.clear();
      clause = word;
      if (["WITH", "RETURN", "YIELD"].includes(word)) projection = { kind: word, start: index + 1 };
    }
    if (stack.length === 0 && clause === "UNWIND" && word === "AS") {
      const name = graphIdentifier(tokens[index + 1]);
      if (name) bindings.set(name, emptyBinding());
    }
    if (stack.length === 0 && token.text === "|") {
      const projected = projection ? projections(tokens.slice(projection.start, index), bindings) : new Map<string, GraphCompletionBinding>();
      pipelineFields = [...projected.keys()];
      bindings = projected;
      projection = undefined;
      clause = "";
    }
    if (["(", "[", "{"].includes(token.text)) {
      let kind: "node" | "relationship" | "properties" | undefined;
      let objects: string[] = [];
      const pattern = ["MATCH", "CREATE", "MERGE"].includes(clause);
      const boundary = !previous || previous.kind === "keyword" || ["=", ",", "("].includes(previous.text) || /^[<>-]+$/.test(previous.text);
      if (pattern && boundary && (token.text === "(" || (token.text === "[" && /-/.test(previous?.text ?? "")))) {
        kind = token.text === "(" ? "node" : "relationship";
        const variable = graphIdentifier(tokens[index + 1]);
        let next = variable ? index + 2 : index + 1;
        while ([":", "|", "&"].includes(tokens[next]?.text ?? "")) {
          if (tokens[next + 1]?.text === ":") next++;
          const label = graphIdentifier(tokens[next + 1]);
          if (label) objects.push(label);
          next += 2;
        }
        if (variable && (tokens[index + 1]?.kind !== "keyword" || tokens[index + 1]?.text.startsWith("`"))) {
          const known = bindings.get(variable);
          bindings.set(variable, { objects: objects.length ? objects : (known?.objects ?? []), relationship: kind === "relationship" });
        }
        if (token.text === "(" && previous?.text === "=") {
          const path = graphIdentifier(tokens[index - 2]);
          if (path) bindings.set(path, emptyBinding());
        }
      } else if (token.text === "{" && ["node", "relationship"].includes(stack[stack.length - 1]?.kind ?? "")) {
        kind = "properties";
        objects = stack[stack.length - 1]!.objects;
      }
      stack.push({ delimiter: token.text, kind, objects });
    } else if ([")", "]", "}"].includes(token.text)) stack.pop();
  }
  const tail = tokens[tokens.length - 1]?.text;
  const frame = stack[stack.length - 1];
  return { bindings, pipelineFields, propertyMapObjects: frame?.kind === "properties" && ["{", ","].includes(tail ?? "") ? frame.objects : undefined };
}
