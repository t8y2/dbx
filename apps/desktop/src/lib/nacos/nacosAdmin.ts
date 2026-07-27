import type { NacosConfigHistoryItem, NacosConfigItem, NacosConfigKey, NacosContentMatch, NacosImplementation, NacosInstanceInfo, NacosRawRequest, NacosServiceInfo, NacosVersionMode } from "@/types/nacos";
import { diffChars, diffLines } from "diff";

export type NacosRawTemplateKey = "serverState" | "namespaceList" | "configDetail" | "serviceList" | "instanceList";

export interface NacosRawTemplate {
  key: NacosRawTemplateKey;
  method: string;
  path: string;
  query: string;
  body: string;
}

export const NACOS_RAW_TEMPLATES: NacosRawTemplate[] = [
  { key: "serverState", method: "GET", path: "/v3/console/server/state", query: "", body: "" },
  { key: "namespaceList", method: "GET", path: "/v3/console/core/namespace/list", query: "", body: "" },
  {
    key: "configDetail",
    method: "GET",
    path: "/v3/console/cs/config",
    query: "dataId=application.yaml&groupName=DEFAULT_GROUP&namespaceId=",
    body: "",
  },
  {
    key: "serviceList",
    method: "GET",
    path: "/v3/console/ns/service/list",
    query: "pageNo=1&pageSize=20&namespaceId=",
    body: "",
  },
  {
    key: "instanceList",
    method: "GET",
    path: "/v3/console/ns/instance/list",
    query: "serviceName=DEFAULT_GROUP@@example&namespaceId=",
    body: "",
  },
];

export interface RNacosOpenApiFallback {
  serverAddr: string;
  contextPath: string;
}

export interface RNacosOpenApiFallbackOptions {
  /** Treat the well-known r-nacos console port as a candidate after the original connection fails. */
  allowConsolePortInference?: boolean;
}

export interface NacosEndpointNormalization {
  serverAddr: string;
  contextPath: string;
  detectedImplementation?: NacosImplementation;
  detectedVersion?: Exclude<NacosVersionMode, "auto">;
  warnings: string[];
}

export interface NacosEndpointNormalizationOptions {
  implementation?: NacosImplementation;
  versionMode?: NacosVersionMode;
  contextPath?: string;
}

/**
 * Splits a pasted browser/API URL into the persisted origin and API context.
 * We only strip documented Nacos 3 UI routes; every other prefix remains an
 * explicit context path so reverse proxies are not silently broken.
 */
export function normalizeNacosEndpoint(input: string, options: NacosEndpointNormalizationOptions = {}): NacosEndpointNormalization {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Nacos address must be a valid absolute URL");
  }
  if (url.username || url.password) throw new Error("Nacos address must not contain embedded credentials");

  const rawPath = url.pathname.replace(/\/+$/, "");
  const implementation = options.implementation;
  const versionMode = options.versionMode || "auto";
  const warnings: string[] = [];
  const hasRNacosSuffix = /\/rnacos$/i.test(rawPath);
  const hasNacosSuffix = /\/nacos$/i.test(rawPath);
  const hasNacos3UiSuffix = /\/(?:next(?:\/index\.html)?|index\.html)$/i.test(rawPath);
  const detectedImplementation: NacosImplementation | undefined = implementation || (hasRNacosSuffix || url.port === "10848" ? "rnacos" : "nacos");
  const detectedVersion: Exclude<NacosVersionMode, "auto"> | undefined = detectedImplementation === "rnacos" ? undefined : versionMode === "auto" ? (hasNacos3UiSuffix ? "v3" : hasNacosSuffix ? "v2" : undefined) : versionMode;
  let contextPath = rawPath;

  if (detectedImplementation === "rnacos") {
    if (hasRNacosSuffix || url.port === "10848") warnings.push("This looks like an r-nacos console URL; use the compatible API address as the primary endpoint.");
    contextPath = hasNacosSuffix ? rawPath : options.contextPath?.trim() || "/nacos";
  } else if (detectedVersion === "v3" || hasNacos3UiSuffix) {
    contextPath = rawPath.replace(/\/(?:next(?:\/index\.html)?|index\.html)$/i, "");
    if (!contextPath) contextPath = options.contextPath?.trim() || "/nacos";
    if (hasNacos3UiSuffix) warnings.push("The Nacos 3 console route was removed from the API context.");
  } else if (!contextPath) {
    contextPath = options.contextPath?.trim() || (versionMode === "v2" ? "/nacos" : "");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return {
    serverAddr: url.toString().replace(/\/$/, ""),
    contextPath: contextPath ? `/${contextPath.replace(/^\/+|\/+$/g, "")}` : "",
    detectedImplementation,
    detectedVersion,
    warnings,
  };
}

export function normalizeNacosMetricsUrl(input: string): string {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Nacos Prometheus metrics URL must be a valid absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Nacos Prometheus metrics URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Nacos Prometheus metrics URL must not contain embedded credentials");
  if (value.includes("#")) throw new Error("Nacos Prometheus metrics URL must not contain a fragment");
  return url.toString();
}

export function nacosMetricsCandidates(serverAddr: string, contextPath: string, implementation: NacosImplementation): string[] {
  const base = serverAddr.replace(/\/+$/, "");
  const context = contextPath.replace(/\/+$/, "");
  const raw = implementation === "rnacos" ? [`${base}/metrics`, `${base}${context}/metrics`, `${base}/rnacos/metrics`] : [`${base}${context}/actuator/prometheus`, `${base}/nacos/actuator/prometheus`, `${base}/actuator/prometheus`];
  return [...new Set(raw.map((value) => new URL(value).toString()))];
}

/**
 * r-nacos exposes its Nacos-compatible OpenAPI on the service port (8848) at
 * `/nacos`; `/rnacos` on 10848 is the separate web console and rejects these
 * OpenAPI POST requests. Port-only detection is deliberately opt-in: 10848
 * may also be a legitimate user mapping for a normal Nacos OpenAPI, so callers
 * must only use that weaker signal as a tested fallback candidate.
 */
export function resolveRNacosOpenApiFallback(serverAddr: string, contextPath: string, options: RNacosOpenApiFallbackOptions = {}): RNacosOpenApiFallback | null {
  const normalizedContextPath = `/${contextPath.trim().replace(/^\/+|\/+$/g, "")}`.replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(serverAddr.trim());
  } catch {
    return null;
  }

  const explicitRNacosContext = normalizedContextPath === "/rnacos";
  const inferredRNacosConsolePort = options.allowConsolePortInference === true && parsed.port === "10848";
  if (!explicitRNacosContext && !inferredRNacosConsolePort) return null;
  if (parsed.port === "10848") parsed.port = "8848";

  return {
    serverAddr: parsed.toString().replace(/\/$/, ""),
    contextPath: "/nacos",
  };
}

export function parseNacosRawQuery(text: string): Record<string, string> | undefined {
  const trimmed = text.trim().replace(/^\?/, "");
  if (!trimmed) return undefined;
  return Object.fromEntries(new URLSearchParams(trimmed).entries());
}

export function parseNacosRawBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

export function buildNacosRawRequest(method: string, path: string, queryText: string, bodyText: string): NacosRawRequest {
  return {
    method,
    path: path.trim(),
    query: parseNacosRawQuery(queryText),
    body: parseNacosRawBody(bodyText),
  };
}

export function isNacosRawMutation(method: string): boolean {
  return method.trim().toUpperCase() !== "GET";
}

export function isNacosErrorCode(error: unknown, code: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`NACOS_ERROR[${code}]`);
}

export function formatNacosConfigIdentity(item: Pick<NacosConfigItem, "namespace" | "dataId" | "group">, fallbackNamespace = ""): string {
  return [`namespace=${item.namespace || fallbackNamespace || "public"}`, `dataId=${item.dataId}`, `group=${item.group || "DEFAULT_GROUP"}`].join("\n");
}

export function buildNacosConfigExport(item: NacosConfigItem, content: string): string {
  return [`# namespace: ${item.namespace || "public"}`, `# dataId: ${item.dataId}`, `# group: ${item.group || "DEFAULT_GROUP"}`, item.configType ? `# type: ${item.configType}` : "", "", content].filter((line, index) => index >= 4 || line).join("\n");
}

export function buildNacosConfigCopy(item: NacosConfigItem, content: string): string {
  return `${formatNacosConfigIdentity(item)}\n\n${content}`;
}

export function resolveNacosConfigCopyText(selectionText: string, editorText: string | undefined, stateText: string): string {
  return selectionText || editorText || stateText;
}

export interface NacosLatestRequestGuard {
  begin(): number;
  invalidate(): void;
  isCurrent(requestId: number): boolean;
}

export function createNacosLatestRequestGuard(): NacosLatestRequestGuard {
  let sequence = 0;
  return {
    begin() {
      sequence += 1;
      return sequence;
    },
    invalidate() {
      sequence += 1;
    },
    isCurrent(requestId) {
      return requestId === sequence;
    },
  };
}

export interface NacosConfigSaveSnapshot {
  requestId: number;
  editorSessionId: number;
  connectionId: string;
  wasCreating: boolean;
  originalKey: NacosConfigKey | null;
  targetKey: NacosConfigKey;
  config: NacosConfigItem;
  content: string;
  configType: string;
}

export interface NacosConfigSaveSnapshotInput {
  requestId: number;
  editorSessionId: number;
  connectionId: string;
  fallbackNamespace?: string;
  originalKey: NacosConfigKey | null;
  config: NacosConfigItem;
  content: string;
  configType: string;
}

export function createNacosConfigSaveSnapshot(input: NacosConfigSaveSnapshotInput): NacosConfigSaveSnapshot {
  const dataId = input.config.dataId.trim();
  const group = input.config.group.trim() || "DEFAULT_GROUP";
  const namespace = input.originalKey?.namespace || input.config.namespace || input.fallbackNamespace || undefined;
  const configType = input.configType || "text";
  const config: NacosConfigItem = {
    ...input.config,
    namespace: namespace || "",
    dataId,
    group,
    content: input.content,
    configType,
  };
  return {
    requestId: input.requestId,
    editorSessionId: input.editorSessionId,
    connectionId: input.connectionId,
    wasCreating: !input.originalKey,
    originalKey: input.originalKey ? { ...input.originalKey } : null,
    targetKey: { namespace, dataId, group },
    config,
    content: input.content,
    configType,
  };
}

export interface NacosConfigEditorComparableState {
  latestRequestId: number;
  editorSessionId: number;
  connectionId: string;
  originalKey: NacosConfigKey | null;
  config: NacosConfigItem | null;
  content: string;
  configType: string;
}

function sameNacosConfigKey(left: NacosConfigKey | null, right: NacosConfigKey | null): boolean {
  if (!left || !right) return left === right;
  return (left.namespace || "") === (right.namespace || "") && left.dataId === right.dataId && (left.group || "DEFAULT_GROUP") === (right.group || "DEFAULT_GROUP");
}

export function isNacosConfigSaveSnapshotSameEditor(snapshot: NacosConfigSaveSnapshot, current: NacosConfigEditorComparableState): boolean {
  const config = current.config;
  return (
    snapshot.requestId === current.latestRequestId &&
    snapshot.editorSessionId === current.editorSessionId &&
    snapshot.connectionId === current.connectionId &&
    sameNacosConfigKey(snapshot.originalKey, current.originalKey) &&
    !!config &&
    snapshot.config.dataId === config.dataId.trim() &&
    snapshot.config.group === (config.group.trim() || "DEFAULT_GROUP") &&
    (snapshot.config.namespace || "") === (config.namespace || snapshot.targetKey.namespace || "")
  );
}

export function isNacosConfigSaveSnapshotCurrent(snapshot: NacosConfigSaveSnapshot, current: NacosConfigEditorComparableState): boolean {
  const config = current.config;
  return (
    isNacosConfigSaveSnapshotSameEditor(snapshot, current) &&
    !!config &&
    snapshot.content === current.content &&
    snapshot.configType === current.configType &&
    (snapshot.config.appName || "") === (config.appName || "") &&
    (snapshot.config.desc || "") === (config.desc || "") &&
    (snapshot.config.tags || "") === (config.tags || "")
  );
}

export type NacosConfigSaveCompletion =
  | { kind: "stale" }
  | {
      kind: "saved" | "saved-with-later-edits";
      originalKey: NacosConfigKey;
      savedConfig: NacosConfigItem;
      baseline: {
        content: string;
        configType: string;
        appName: string;
        desc: string;
        tags: string;
      };
    };

export function resolveNacosConfigSaveCompletion(snapshot: NacosConfigSaveSnapshot, current: NacosConfigEditorComparableState): NacosConfigSaveCompletion {
  if (!isNacosConfigSaveSnapshotSameEditor(snapshot, current)) return { kind: "stale" };
  return {
    kind: isNacosConfigSaveSnapshotCurrent(snapshot, current) ? "saved" : "saved-with-later-edits",
    originalKey: { ...snapshot.targetKey },
    savedConfig: { ...snapshot.config },
    baseline: {
      content: snapshot.content,
      configType: snapshot.configType,
      appName: snapshot.config.appName || "",
      desc: snapshot.config.desc || "",
      tags: snapshot.config.tags || "",
    },
  };
}

export function canDeleteNacosConfig(readOnly: boolean, originalKey: NacosConfigKey | null): boolean {
  return !readOnly && !!originalKey;
}

export interface NacosConfigMutationGuardState {
  readOnly: boolean;
  saving: boolean;
  deleting: boolean;
  hasPendingDelete: boolean;
  hasPendingSave: boolean;
}

export function canStartNacosConfigSave(state: NacosConfigMutationGuardState): boolean {
  return !state.readOnly && !state.saving && !state.deleting && !state.hasPendingDelete;
}

export function canStartNacosConfigDelete(state: NacosConfigMutationGuardState, originalKey: NacosConfigKey | null): boolean {
  return canDeleteNacosConfig(state.readOnly, originalKey) && !state.saving && !state.deleting && !state.hasPendingSave && !state.hasPendingDelete;
}

export interface NacosConfigDeleteSnapshot {
  connectionId: string;
  key: NacosConfigKey;
  config: NacosConfigItem;
}

export function createNacosConfigDeleteSnapshot(connectionId: string, key: NacosConfigKey, config: NacosConfigItem): NacosConfigDeleteSnapshot {
  return {
    connectionId,
    key: {
      namespace: key.namespace || undefined,
      dataId: key.dataId,
      group: key.group || "DEFAULT_GROUP",
    },
    config: {
      ...config,
      namespace: key.namespace || "",
      dataId: key.dataId,
      group: key.group || "DEFAULT_GROUP",
    },
  };
}

export function isNacosConfigDeleteSnapshotInScope(snapshot: NacosConfigDeleteSnapshot, connectionId: string, namespace?: string): boolean {
  return snapshot.connectionId === connectionId && (snapshot.key.namespace || "") === (namespace || "");
}

export interface NacosLiteralMatchSegment {
  text: string;
  matched: boolean;
}

export function splitNacosContentLiteralMatches(text: string, query: string): NacosLiteralMatchSegment[] {
  if (!text || !query) return text ? [{ text, matched: false }] : [];
  const segments: NacosLiteralMatchSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const matchIndex = text.indexOf(query, cursor);
    if (matchIndex < 0) {
      segments.push({ text: text.slice(cursor), matched: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), matched: false });
    }
    segments.push({ text: text.slice(matchIndex, matchIndex + query.length), matched: true });
    cursor = matchIndex + query.length;
  }
  return segments;
}

function nacosSearchCsvCell(value: string | number): string {
  let text = String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildNacosContentSearchCsv(matches: readonly NacosContentMatch[]): string {
  const rows: Array<Array<string | number>> = [["namespace", "group", "dataId", "lineNumber", "snippet"], ...matches.map((match) => [match.namespace || "public", match.group || "DEFAULT_GROUP", match.dataId, match.lineNumber, match.snippet])];
  return `\uFEFF${rows.map((row) => row.map(nacosSearchCsvCell).join(",")).join("\r\n")}\r\n`;
}

export function sanitizeNacosConfigFileNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[._\s-]+/, "")
    .replace(/\.+$/, "");
  return sanitized || "nacos-config";
}

export function nacosConfigFileExtension(configType?: string): string {
  const normalized = configType?.trim().toLowerCase();
  if (normalized === "yaml" || normalized === "yml") return "yaml";
  if (normalized === "json") return "json";
  if (normalized === "xml") return "xml";
  if (normalized === "html") return "html";
  if (normalized === "properties" || normalized === "props") return "properties";
  if (normalized === "toml") return "toml";
  return "txt";
}

export function buildNacosConfigExportFileName(item: Pick<NacosConfigItem, "dataId" | "configType">): string {
  const baseName = sanitizeNacosConfigFileNameSegment(item.dataId || "nacos-config");
  if (/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(baseName)) return baseName;
  return `${baseName}.${nacosConfigFileExtension(item.configType)}`;
}

export function createNacosSaveAsCopy(item: NacosConfigItem): NacosConfigItem {
  return {
    ...item,
    dataId: item.dataId ? `${item.dataId}.copy` : "",
    content: item.content ?? "",
  };
}

export interface NacosDiffSummary {
  changed: boolean;
  addedLines: number;
  removedLines: number;
  preview: string;
}

export type NacosDiffLineType = "equal" | "delete" | "insert" | "modify" | "padding";

export interface NacosInlineSegment {
  value: string;
  changed: boolean;
}

export interface NacosSideBySideDiffRow {
  id: string;
  leftLineNumber: number | null;
  rightLineNumber: number | null;
  leftContent: string;
  rightContent: string;
  leftType: NacosDiffLineType;
  rightType: NacosDiffLineType;
  leftInline: NacosInlineSegment[];
  rightInline: NacosInlineSegment[];
}

export interface NacosInlineDiffRow {
  id: string;
  lineNumber: number | null;
  content: string;
  type: Exclude<NacosDiffLineType, "modify" | "padding">;
  segments: NacosInlineSegment[];
}

export function summarizeNacosConfigDiff(before: string, after: string, maxPreviewLines = 40): NacosDiffSummary {
  if (before === after) {
    return { changed: false, addedLines: 0, removedLines: 0, preview: "No content changes." };
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) continue;
    if (left !== undefined) {
      removedLines += 1;
      lines.push(`- ${left}`);
    }
    if (right !== undefined) {
      addedLines += 1;
      lines.push(`+ ${right}`);
    }
    if (lines.length >= maxPreviewLines) {
      lines.push("...");
      break;
    }
  }
  return { changed: true, addedLines, removedLines, preview: lines.join("\n") };
}

function normalizeNacosDiffText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitDiffLines(value: string): string[] {
  const lines = normalizeNacosDiffText(value).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function inlineSegments(left: string, right: string): { left: NacosInlineSegment[]; right: NacosInlineSegment[] } {
  const changes = diffChars(left, right);
  const leftSegments: NacosInlineSegment[] = [];
  const rightSegments: NacosInlineSegment[] = [];
  for (const change of changes) {
    if (change.removed) {
      leftSegments.push({ value: change.value, changed: true });
    } else if (change.added) {
      rightSegments.push({ value: change.value, changed: true });
    } else {
      leftSegments.push({ value: change.value, changed: false });
      rightSegments.push({ value: change.value, changed: false });
    }
  }
  return { left: leftSegments, right: rightSegments };
}

function pairChangedLines(leftLines: string[], rightLines: string[], leftStart: number, rightStart: number, rows: NacosSideBySideDiffRow[], nextId: () => string) {
  const max = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < max; index += 1) {
    const left = leftLines[index];
    const right = rightLines[index];
    const hasLeft = left !== undefined;
    const hasRight = right !== undefined;
    const inline = hasLeft && hasRight ? inlineSegments(left, right) : { left: [], right: [] };
    rows.push({
      id: nextId(),
      leftLineNumber: hasLeft ? leftStart + index : null,
      rightLineNumber: hasRight ? rightStart + index : null,
      leftContent: left ?? "",
      rightContent: right ?? "",
      leftType: hasLeft ? (hasRight ? "modify" : "delete") : "padding",
      rightType: hasRight ? (hasLeft ? "modify" : "insert") : "padding",
      leftInline: inline.left,
      rightInline: inline.right,
    });
  }
}

export function buildNacosSideBySideDiff(before: string, after: string): NacosSideBySideDiffRow[] {
  const changes = diffLines(normalizeNacosDiffText(before), normalizeNacosDiffText(after), { newlineIsToken: false });
  const rows: NacosSideBySideDiffRow[] = [];
  let leftLineNumber = 1;
  let rightLineNumber = 1;
  let id = 0;
  const nextId = () => `nacos-diff-${id++}`;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      for (const line of splitDiffLines(change.value)) {
        rows.push({
          id: nextId(),
          leftLineNumber,
          rightLineNumber,
          leftContent: line,
          rightContent: line,
          leftType: "equal",
          rightType: "equal",
          leftInline: [{ value: line, changed: false }],
          rightInline: [{ value: line, changed: false }],
        });
        leftLineNumber += 1;
        rightLineNumber += 1;
      }
      continue;
    }

    if (change.removed) {
      const leftLines = splitDiffLines(change.value);
      const next = changes[index + 1];
      if (next?.added) {
        const rightLines = splitDiffLines(next.value);
        pairChangedLines(leftLines, rightLines, leftLineNumber, rightLineNumber, rows, nextId);
        leftLineNumber += leftLines.length;
        rightLineNumber += rightLines.length;
        index += 1;
      } else {
        pairChangedLines(leftLines, [], leftLineNumber, rightLineNumber, rows, nextId);
        leftLineNumber += leftLines.length;
      }
      continue;
    }

    if (change.added) {
      const rightLines = splitDiffLines(change.value);
      pairChangedLines([], rightLines, leftLineNumber, rightLineNumber, rows, nextId);
      rightLineNumber += rightLines.length;
    }
  }

  return rows;
}

function visibleInlineSegments(content: string, segments: NacosInlineSegment[]): NacosInlineSegment[] {
  return segments.length ? segments : [{ value: content, changed: false }];
}

export function buildNacosInlineDiff(before: string, after: string): NacosInlineDiffRow[] {
  return buildNacosSideBySideDiff(before, after).flatMap((row) => {
    if (row.leftType === "equal" && row.rightType === "equal") {
      return [
        {
          id: `${row.id}-equal`,
          lineNumber: row.leftLineNumber,
          content: row.leftContent,
          type: "equal" as const,
          segments: visibleInlineSegments(row.leftContent, row.leftInline),
        },
      ];
    }

    const rows: NacosInlineDiffRow[] = [];
    if (row.leftType === "delete" || row.leftType === "modify") {
      rows.push({
        id: `${row.id}-delete`,
        lineNumber: row.leftLineNumber,
        content: row.leftContent,
        type: "delete",
        segments: visibleInlineSegments(row.leftContent, row.leftInline),
      });
    }
    if (row.rightType === "insert" || row.rightType === "modify") {
      rows.push({
        id: `${row.id}-insert`,
        lineNumber: row.rightLineNumber,
        content: row.rightContent,
        type: "insert",
        segments: visibleInlineSegments(row.rightContent, row.rightInline),
      });
    }
    return rows;
  });
}

export function buildNacosConfigDeleteConfirm(item: NacosConfigItem, fallbackNamespace = ""): string {
  return formatNacosConfigIdentity(item, fallbackNamespace);
}

export function buildNacosConfigHistoryRollbackConfirm(item: NacosConfigHistoryItem, fallbackNamespace = ""): string {
  return [`namespace=${item.namespace || fallbackNamespace || "public"}`, `dataId=${item.dataId}`, `group=${item.group || "DEFAULT_GROUP"}`, item.lastModifiedTime ? `historyTime=${item.lastModifiedTime}` : "", item.operator ? `operator=${item.operator}` : ""].filter(Boolean).join("\n");
}

export function buildNacosInstanceConfirm(service: NacosServiceInfo, instance: NacosInstanceInfo, patch: Partial<NacosInstanceInfo>, fallbackGroup = "", namespace = ""): string {
  const targetEnabled = patch.enabled ?? instance.enabled;
  const targetHealthy = patch.healthy ?? instance.healthy;
  return [
    `namespace=${namespace || "public"}`,
    `serviceName=${service.serviceName}`,
    `group=${instance.groupName || service.groupName || fallbackGroup || "DEFAULT_GROUP"}`,
    `instance=${instance.ip}:${instance.port}`,
    patch.enabled == null ? "" : `targetEnabled=${targetEnabled === false ? "false" : "true"}`,
    patch.healthy == null ? "" : `targetHealthy=${targetHealthy === false ? "false" : "true"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildNacosRawMutationConfirm(req: NacosRawRequest): string {
  return [`method=${req.method.toUpperCase()}`, `path=${req.path}`, req.query ? `query=${JSON.stringify(req.query)}` : ""].filter(Boolean).join("\n");
}
