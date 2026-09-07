export type ResultProtectionAction = "remove" | "mask" | "partial" | "hash" | "deny";
export type ResultProtectionMode = "strict" | "nameOnly";

export interface ResultProtectionRule {
  id: string;
  columnPattern: string | null;
  dataTypePattern: string | null;
  valuePattern: string | null;
  schema: string | null;
  table: string | null;
  action: ResultProtectionAction;
  keepPrefix: number;
  keepSuffix: number;
}

export interface ResultProtectionSettings {
  enabled: boolean;
  mode: ResultProtectionMode;
  rules: ResultProtectionRule[];
}

export interface ResultProtectionOverride {
  connectionId: string;
  database: string | null;
  settings: ResultProtectionSettings;
}

export interface McpResultProtectionPolicy {
  default: ResultProtectionSettings;
  overrides: ResultProtectionOverride[];
  hashKey: string | null;
}

export interface ResultProtectionHit {
  ruleId: string;
  column: string;
  action: ResultProtectionAction;
}

export interface ResultProtectionPreview {
  policy: McpResultProtectionPolicy;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  column: string;
  dataType: string;
  value: unknown;
}

export function createMcpResultProtectionPolicy(): McpResultProtectionPolicy {
  return { default: { enabled: false, mode: "strict", rules: [] }, overrides: [], hashKey: null };
}

export function createResultProtectionRule(id: string): ResultProtectionRule {
  return { id, columnPattern: null, dataTypePattern: null, valuePattern: null, schema: null, table: null, action: "mask", keepPrefix: 0, keepSuffix: 0 };
}

export function resultProtectionTemplate(): ResultProtectionRule[] {
  return [
    { ...createResultProtectionRule("credentials"), columnPattern: "password|passwd|(^|_)pwd($|_)|secret|token|api[_-]?key|private[_-]?key|access[_-]?key", action: "remove" },
    { ...createResultProtectionRule("phone"), columnPattern: "phone|mobile|telephone", action: "partial", keepPrefix: 3, keepSuffix: 4 },
    { ...createResultProtectionRule("identity"), columnPattern: "id[_-]?card|identity[_-]?number|national[_-]?id", action: "partial", keepPrefix: 3, keepSuffix: 2 },
    { ...createResultProtectionRule("email"), columnPattern: "e[_-]?mail", action: "partial", keepPrefix: 2 },
  ];
}

export function prepareResultProtectionPolicy(policy: McpResultProtectionPolicy): McpResultProtectionPolicy {
  const copy: McpResultProtectionPolicy = JSON.parse(JSON.stringify(policy));
  const settings = [copy.default, ...copy.overrides.map((override) => override.settings)];
  if (!copy.hashKey && settings.some((scope) => scope.rules.some((rule) => rule.action === "hash"))) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    copy.hashKey = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return copy;
}
