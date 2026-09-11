import catalog from "@/lib/sql/doris/functions.generated.json";

export interface DorisFunctionDefinition {
  name: string;
  category: string;
  signatures: string[];
  docs: string;
  documentedIn: string[];
}

const definitions = catalog.functions as DorisFunctionDefinition[];

function splitParameters(value: string): string[] {
  const parameters: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "<" || character === "[") depth += 1;
    if (character === ")" || character === ">" || character === "]") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parameters.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parameters.push(last);
  return parameters;
}

function parameterName(value: string, index: number): string {
  const placeholder = /<([^>]+)>/.exec(value)?.[1] ?? value;
  const cleaned = placeholder
    .replace(/\[.*$/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "");
  return cleaned || `arg${index + 1}`;
}

function parametersFor(definition: DorisFunctionDefinition): string[] {
  const signature = definition.signatures.find((item) => item.includes("("));
  if (!signature) return ["expression"];
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close <= open) return ["expression"];
  return splitParameters(signature.slice(open + 1, close))
    .filter((item) => item && !/^\.\.\.$/.test(item))
    .map(parameterName);
}

export const DORIS_FUNCTION_DEFINITIONS = definitions;
const compatibilityOverrides: DorisFunctionDefinition[] = [
  {
    name: "JSON_EXTRACT_STRING",
    category: "JSON",
    signatures: ["JSON_EXTRACT_STRING(json_string, path)"],
    docs: "Extracts a string value from a JSON string by path.",
    documentedIn: ["Apache Doris JSON function compatibility"],
  },
];
for (const definition of compatibilityOverrides) {
  if (!DORIS_FUNCTION_DEFINITIONS.some((item) => item.name === definition.name)) DORIS_FUNCTION_DEFINITIONS.push(definition);
}
export const DORIS_FUNCTION_SIGNATURES = new Map(DORIS_FUNCTION_DEFINITIONS.map((definition) => [definition.name, parametersFor(definition)]));
export const DORIS_FUNCTION_DOCS = new Map(DORIS_FUNCTION_DEFINITIONS.map((definition) => [definition.name, `${definition.category} · ${definition.docs}`]));
