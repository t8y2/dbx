import { executeQuery } from "@/lib/backend/api";
import { parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";

/**
 * Solr Admin 面板的数据层：所有请求复用 REST 控制台链路
 * （execute_query → solr_driver::execute_rest_query），后端零新增命令。
 * 非表格化 JSON 响应由驱动包装为 [status, response] 单行返回；
 * /response/docs 形态走 elasticsearch_raw_body 透出原文。
 */

export interface SolrAdminResponse {
  status: number;
  /** 解析后的 JSON；非 JSON 时为原始文本；空响应为 null。 */
  body: unknown;
  rawBody: string;
  elapsedMs: number;
}

export type SolrAdminMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD";

export async function solrAdminRequest(connectionId: string, method: SolrAdminMethod, path: string, body?: string): Promise<SolrAdminResponse> {
  const sql = body ? `${method} ${path}\n${body}` : `${method} ${path}`;
  const result = await executeQuery(connectionId, "", sql);
  const status = typeof result.rows?.[0]?.[0] === "number" ? result.rows[0][0] : 200;
  const rawBody = result.elasticsearch_raw_body ?? (typeof result.rows?.[0]?.[1] === "string" ? result.rows[0][1] : "");
  let parsed: unknown = null;
  if (rawBody) {
    try {
      parsed = parseJsonPreservingLargeNumbers(rawBody);
    } catch {
      parsed = rawBody;
    }
  }
  return { status, body: parsed, rawBody, elapsedMs: result.execution_time_ms };
}

export function solrAdminGet(connectionId: string, path: string): Promise<SolrAdminResponse> {
  return solrAdminRequest(connectionId, "GET", path);
}

/** Solr 错误体 {"error":{"msg","code"}} → 可读消息；用于写操作的状态判定。 */
export function solrAdminErrorMessage(res: SolrAdminResponse): string | null {
  if (res.status < 400) return null;
  const body = res.body as Record<string, unknown> | null;
  const msg = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).msg : undefined;
  return `Solr error (${res.status}): ${typeof msg === "string" ? msg : res.rawBody.slice(0, 500)}`;
}

/** 服务端点（server scope）与 core 端点（core scope，{core} 占位）。 */
export interface SolrAdminViewDef {
  id: SolrAdminViewId;
  scope: "server" | "core";
  /** REST 路径模板；core scope 中 {core} 会被替换。 */
  path: string;
  /** 需要专用渲染而非通用 JSON 树。 */
  view: "generic" | "dashboard" | "properties" | "logging" | "coreAdmin" | "overview" | "ping" | "schema" | "analysis" | "segments" | "action";
}

export type SolrAdminViewId = "dashboard" | "logging" | "javaProps" | "threads" | "coreAdmin" | "metrics" | "overview" | "analysis" | "documents" | "paramsets" | "files" | "ping" | "plugins" | "query" | "replication" | "schema" | "segments";

export const SOLR_ADMIN_SERVER_VIEWS: readonly SolrAdminViewDef[] = [
  { id: "dashboard", scope: "server", path: "/admin/info/system", view: "dashboard" },
  { id: "logging", scope: "server", path: "/admin/info/logging", view: "logging" },
  { id: "javaProps", scope: "server", path: "/admin/info/properties", view: "properties" },
  { id: "threads", scope: "server", path: "/admin/info/threads", view: "generic" },
  { id: "coreAdmin", scope: "server", path: "/admin/cores?action=STATUS", view: "coreAdmin" },
  { id: "metrics", scope: "server", path: "/admin/metrics", view: "generic" },
];

export const SOLR_ADMIN_CORE_VIEWS: readonly SolrAdminViewDef[] = [
  { id: "overview", scope: "core", path: "/{core}/admin/luke", view: "overview" },
  { id: "analysis", scope: "core", path: "/{core}/analysis/field", view: "analysis" },
  { id: "documents", scope: "core", path: "", view: "action" },
  { id: "paramsets", scope: "core", path: "/{core}/config/params", view: "generic" },
  { id: "files", scope: "core", path: "/{core}/admin/file", view: "generic" },
  { id: "ping", scope: "core", path: "/{core}/admin/ping", view: "ping" },
  { id: "plugins", scope: "core", path: "/{core}/admin/mbeans?stats=true", view: "generic" },
  { id: "query", scope: "core", path: "", view: "action" },
  { id: "replication", scope: "core", path: "/{core}/replication?command=details", view: "generic" },
  { id: "schema", scope: "core", path: "/{core}/schema", view: "schema" },
  { id: "segments", scope: "core", path: "/{core}/admin/segments", view: "segments" },
];

export function solrAdminViewById(id: SolrAdminViewId): SolrAdminViewDef | undefined {
  return [...SOLR_ADMIN_SERVER_VIEWS, ...SOLR_ADMIN_CORE_VIEWS].find((view) => view.id === id);
}

export function solrAdminPath(view: SolrAdminViewDef, core: string): string {
  return view.path.replace("{core}", encodeURIComponent(core));
}

/* ---------- Core Admin ---------- */

export interface SolrCoreStatus {
  name: string;
  instanceDir?: string;
  dataDir?: string;
  config?: string;
  schema?: string;
  startTime?: string;
  uptime?: number;
  numDocs?: number;
  maxDoc?: number;
  deletedDocs?: number;
  sizeInBytes?: number;
  version?: number;
  segmentCount?: number;
}

export function parseCoreStatus(body: unknown): SolrCoreStatus[] {
  const status = (body as Record<string, unknown> | null)?.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return [];
  return Object.entries(status as Record<string, Record<string, unknown>>).map(([name, info]) => {
    const index = (info?.index ?? {}) as Record<string, unknown>;
    return {
      name: typeof info?.name === "string" ? info.name : name,
      instanceDir: info?.instanceDir as string | undefined,
      dataDir: info?.dataDir as string | undefined,
      config: info?.config as string | undefined,
      schema: info?.schema as string | undefined,
      startTime: info?.startTime as string | undefined,
      uptime: typeof info?.uptime === "number" ? info.uptime : undefined,
      numDocs: typeof index.numDocs === "number" ? index.numDocs : undefined,
      maxDoc: typeof index.maxDoc === "number" ? index.maxDoc : undefined,
      deletedDocs: typeof index.deletedDocs === "number" ? index.deletedDocs : undefined,
      sizeInBytes: typeof index.sizeInBytes === "number" ? index.sizeInBytes : typeof index.size === "number" ? index.size : undefined,
      version: typeof index.version === "number" ? index.version : undefined,
      segmentCount: typeof index.segmentCount === "number" ? index.segmentCount : undefined,
    };
  });
}

export type SolrCoreAction = "CREATE" | "RELOAD" | "UNLOAD" | "RENAME" | "SWAP";

/** CoreAdmin 写操作统一走 GET /admin/cores（Solr 官方形态），参数全部由 UI 收集。 */
export function solrCoreAdminRequest(connectionId: string, params: Record<string, string>): Promise<SolrAdminResponse> {
  const query = new URLSearchParams(params).toString();
  return solrAdminRequest(connectionId, "GET", `/admin/cores?${query}`);
}

/* ---------- Schema ---------- */

export interface SolrSchemaField {
  name: string;
  type?: string;
  stored?: boolean;
  indexed?: boolean;
  required?: boolean;
  multiValued?: boolean;
  docValues?: boolean;
  uninvertible?: boolean;
}

export interface SolrSchemaInfo {
  name?: string;
  version?: string;
  uniqueKey?: string;
  fields: SolrSchemaField[];
  dynamicFields: SolrSchemaField[];
  copyFields: Array<{ source: string; dest: string; maxChars?: number }>;
  fieldTypeCount: number;
}

export function parseSolrSchema(body: unknown): SolrSchemaInfo {
  const root = (body as Record<string, unknown> | null)?.schema ?? body;
  const schema = (root ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(schema.fields) ? (schema.fields as SolrSchemaField[]) : [];
  const dynamicFields = Array.isArray(schema.dynamicFields) ? (schema.dynamicFields as SolrSchemaField[]) : [];
  const copyFields = Array.isArray(schema.copyFields) ? (schema.copyFields as Array<{ source: string; dest: string; maxChars?: number }>) : [];
  const fieldTypes = Array.isArray(schema.fieldTypes) ? schema.fieldTypes : [];
  return {
    name: schema.name as string | undefined,
    version: schema.version != null ? String(schema.version) : undefined,
    uniqueKey: schema.uniqueKey as string | undefined,
    fields,
    dynamicFields,
    copyFields,
    fieldTypeCount: fieldTypes.length,
  };
}

/* ---------- Analysis ---------- */

export interface SolrAnalysisStage {
  /** 分析器类名，如 org.apache.lucene.analysis.standard.StandardTokenizer */
  name: string;
  tokens: string[];
}

export interface SolrAnalysisResult {
  /** index 侧阶段链 */
  index: SolrAnalysisStage[];
  /** query 侧阶段链 */
  query: SolrAnalysisStage[];
}

/**
 * /analysis/field 响应：analysis.field_names.{f}.index 是
 * [ [stageName, [tokenObj...]], ... ] 交替数组；query 侧结构相同。
 */
export function parseAnalysisResponse(body: unknown, fieldName: string): SolrAnalysisResult {
  const analysis = (body as Record<string, unknown> | null)?.analysis as Record<string, unknown> | undefined;
  const fieldNames = analysis?.field_names as Record<string, unknown> | undefined;
  const entry = (fieldName ? fieldNames?.[fieldName] : undefined) ?? (fieldNames ? Object.values(fieldNames)[0] : undefined);
  const stages = (entry ?? {}) as Record<string, unknown>;
  const parseStages = (raw: unknown): SolrAnalysisStage[] => {
    if (!Array.isArray(raw)) return [];
    const stages: SolrAnalysisStage[] = [];
    for (const item of raw) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const name = typeof item[0] === "string" ? item[0] : String(item[0]);
      const tokenObjs = Array.isArray(item[1]) ? item[1] : [];
      const tokens = tokenObjs.map((token) => {
        if (token && typeof token === "object" && !Array.isArray(token)) {
          const text = (token as Record<string, unknown>).text;
          return text != null ? String(text) : JSON.stringify(token);
        }
        return String(token);
      });
      stages.push({ name, tokens });
    }
    return stages;
  };
  return { index: parseStages(stages.index), query: parseStages(stages.query) };
}

export function solrAnalysisPath(core: string, fieldName: string, fieldValue: string, queryValue?: string): string {
  const params = new URLSearchParams();
  params.set("analysis.fieldname", fieldName);
  params.set("analysis.fieldvalue", fieldValue);
  if (queryValue) params.set("analysis.query", queryValue);
  return `/${encodeURIComponent(core)}/analysis/field?${params.toString()}`;
}
