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
  groupOverrides: { groupId: string; settings: ResultProtectionSettings }[];
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
  groupIds?: string[];
  schema: string;
  table: string;
  column: string;
  dataType: string;
  value: unknown;
}

export type ResultProtectionScope = { kind: "global" } | { kind: "group"; groupId: string } | { kind: "connection"; connectionId: string } | { kind: "database"; connectionId: string; database: string };

export interface ResultProtectionPreviewResult {
  status: "disabled" | "unchanged" | "protected" | "removed" | "denied";
  value?: unknown;
  hits: ResultProtectionHit[];
  source: ResultProtectionScope;
}

export interface ResultProtectionContext {
  connectionId?: string;
  database?: string;
  groupIds?: readonly string[];
}

export function resultProtectionScopeKey(scope: ResultProtectionScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "group") return JSON.stringify([scope.kind, scope.groupId]);
  return JSON.stringify([scope.kind, scope.connectionId, scope.kind === "database" ? scope.database : null]);
}

export function localResultProtectionSettings(policy: McpResultProtectionPolicy, scope: ResultProtectionScope): ResultProtectionSettings | undefined {
  if (scope.kind === "global") return policy.default;
  if (scope.kind === "group") return (policy.groupOverrides ?? []).find((override) => override.groupId === scope.groupId)?.settings;
  return policy.overrides.find((override) => override.connectionId === scope.connectionId && override.database === (scope.kind === "database" ? scope.database : null))?.settings;
}

export function effectiveResultProtection(policy: McpResultProtectionPolicy, context: ResultProtectionContext): { settings: ResultProtectionSettings; source: ResultProtectionScope } {
  const candidates: ResultProtectionScope[] = [];
  if (context.connectionId) {
    if (context.database) candidates.push({ kind: "database", connectionId: context.connectionId, database: context.database });
    candidates.push({ kind: "connection", connectionId: context.connectionId });
  }
  for (const groupId of [...(context.groupIds ?? [])].reverse()) candidates.push({ kind: "group", groupId });
  candidates.push({ kind: "global" });
  for (const source of candidates) {
    const settings = localResultProtectionSettings(policy, source);
    if (settings) return { settings, source };
  }
  return { settings: policy.default, source: { kind: "global" } };
}

export function cloneResultProtectionScope(policy: McpResultProtectionPolicy, scope: ResultProtectionScope, groupIds: readonly string[]): ResultProtectionSettings {
  const existing = localResultProtectionSettings(policy, scope);
  if (existing) return existing;
  const context = scope.kind === "database" ? { connectionId: scope.connectionId, groupIds } : { groupIds: scope.kind === "group" ? groupIds.slice(0, -1) : groupIds };
  const settings: ResultProtectionSettings = JSON.parse(JSON.stringify(effectiveResultProtection(policy, context).settings));
  if (scope.kind === "group") (policy.groupOverrides ??= []).push({ groupId: scope.groupId, settings });
  else if (scope.kind !== "global") policy.overrides.push({ connectionId: scope.connectionId, database: scope.kind === "database" ? scope.database : null, settings });
  return settings;
}

export function removeResultProtectionScope(policy: McpResultProtectionPolicy, scope: ResultProtectionScope): void {
  if (scope.kind === "group") policy.groupOverrides = (policy.groupOverrides ?? []).filter((override) => override.groupId !== scope.groupId);
  else if (scope.kind !== "global") policy.overrides = policy.overrides.filter((override) => override.connectionId !== scope.connectionId || override.database !== (scope.kind === "database" ? scope.database : null));
}

export function createMcpResultProtectionPolicy(): McpResultProtectionPolicy {
  return { default: { enabled: false, mode: "strict", rules: [] }, groupOverrides: [], overrides: [], hashKey: null };
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
  copy.groupOverrides ??= [];
  const settings = [copy.default, ...copy.groupOverrides.map((override) => override.settings), ...copy.overrides.map((override) => override.settings)];
  if (!copy.hashKey && settings.some((scope) => scope.rules.some((rule) => rule.action === "hash"))) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    copy.hashKey = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return copy;
}
