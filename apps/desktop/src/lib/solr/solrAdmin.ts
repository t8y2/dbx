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
  view: "generic" | "dashboard" | "properties" | "logging" | "coreAdmin" | "overview" | "ping" | "schema" | "analysis" | "segments" | "queryForm" | "replication" | "action";
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
  { id: "overview", scope: "core", path: "/{core}/admin/luke?show=index", view: "overview" },
  { id: "analysis", scope: "core", path: "/{core}/analysis/field", view: "analysis" },
  { id: "documents", scope: "core", path: "", view: "action" },
  { id: "paramsets", scope: "core", path: "/{core}/config/params", view: "generic" },
  { id: "files", scope: "core", path: "/{core}/admin/file", view: "generic" },
  { id: "ping", scope: "core", path: "/{core}/admin/ping", view: "ping" },
  { id: "plugins", scope: "core", path: "/{core}/admin/mbeans?stats=true", view: "generic" },
  { id: "query", scope: "core", path: "", view: "queryForm" },
  { id: "replication", scope: "core", path: "/{core}/replication?command=details", view: "replication" },
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

/* ---------- Query Builder（对标官方 Admin UI Query 表单） ---------- */

export interface SolrQueryParam {
  key: string;
  value: string;
}

export interface SolrQueryFormState {
  /** Request-Handler，如 /select、/query */
  handler: string;
  q: string;
  qop: "" | "AND" | "OR";
  fq: string[];
  sort: string;
  start: string;
  rows: string;
  fl: string;
  df: string;
  /** paramset 名（useParams 参数，逗号拼接） */
  useParams: string[];
  wt: string;
  indent: boolean;
  debugQuery: boolean;
  defType: string;
  hl: { enabled: boolean; fl: string; snippets: string; fragsize: string; simplePre: string; simplePost: string; requireFieldMatch: boolean; mergeContiguous: boolean };
  facet: { enabled: boolean; queries: string[]; fields: string[]; prefix: string; sort: string; limit: string; offset: string; mincount: string; missing: boolean };
  spatial: { enabled: boolean; pt: string; sfield: string; d: string; geofilt: boolean; bbox: boolean };
  spellcheck: { enabled: boolean; q: string; build: boolean; collate: boolean; count: string; dictionary: string; onlyMorePopular: boolean };
  rawParams: SolrQueryParam[];
  /** 非空时改用 JSON Request DSL：POST {handler} + body，与参数表单互斥 */
  jsonQuery: string;
}

export function defaultSolrQueryForm(): SolrQueryFormState {
  return {
    handler: "/select",
    q: "*:*",
    qop: "",
    fq: [],
    sort: "",
    start: "0",
    rows: "10",
    fl: "",
    df: "",
    useParams: [],
    wt: "json",
    indent: true,
    debugQuery: false,
    defType: "",
    hl: { enabled: false, fl: "", snippets: "", fragsize: "", simplePre: "", simplePost: "", requireFieldMatch: false, mergeContiguous: false },
    facet: { enabled: false, queries: [], fields: [], prefix: "", sort: "", limit: "", offset: "", mincount: "", missing: false },
    spatial: { enabled: false, pt: "", sfield: "", d: "", geofilt: false, bbox: false },
    spellcheck: { enabled: false, q: "", build: false, collate: false, count: "", dictionary: "", onlyMorePopular: false },
    rawParams: [],
    jsonQuery: "",
  };
}

export interface SolrBuiltQuery {
  /** REST 控制台可执行文本："GET /path?qs" 或 "POST /path\n{json}" */
  text: string;
  jsonMode: boolean;
}

const nonEmpty = (v: string) => v.trim() !== "";

/** 表单 → REST 文本。重复参数（fq/facet.field…）经 URLSearchParams.append 保留多值。 */
export function buildSolrQuery(core: string, state: SolrQueryFormState): SolrBuiltQuery {
  const handler = state.handler.trim() || "/select";
  const base = `/${encodeURIComponent(core)}${handler.startsWith("/") ? handler : `/${handler}`}`;

  if (nonEmpty(state.jsonQuery)) {
    return { text: `POST ${base}\n${state.jsonQuery.trim()}`, jsonMode: true };
  }

  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value != null && nonEmpty(value)) params.set(key, value.trim());
  };
  const appendEach = (key: string, values: string[]) => {
    for (const v of values) if (nonEmpty(v)) params.append(key, v.trim());
  };

  set("q", state.q || "*:*");
  set("q.op", state.qop);
  appendEach("fq", state.fq);
  set("sort", state.sort);
  set("start", state.start);
  set("rows", state.rows);
  set("fl", state.fl);
  set("df", state.df);
  if (state.useParams.length) params.set("useParams", state.useParams.join(","));
  set("wt", state.wt);
  if (state.indent) params.set("indent", "on");
  if (state.debugQuery) params.set("debugQuery", "true");
  set("defType", state.defType);

  const hl = state.hl;
  if (hl.enabled) {
    params.set("hl", "true");
    set("hl.fl", hl.fl);
    set("hl.snippets", hl.snippets);
    set("hl.fragsize", hl.fragsize);
    set("hl.simple.pre", hl.simplePre);
    set("hl.simple.post", hl.simplePost);
    if (hl.requireFieldMatch) params.set("hl.requireFieldMatch", "true");
    if (hl.mergeContiguous) params.set("hl.mergeContiguous", "true");
  }

  const facet = state.facet;
  if (facet.enabled) {
    params.set("facet", "true");
    appendEach("facet.query", facet.queries);
    appendEach("facet.field", facet.fields);
    set("facet.prefix", facet.prefix);
    set("facet.sort", facet.sort);
    set("facet.limit", facet.limit);
    set("facet.offset", facet.offset);
    set("facet.mincount", facet.mincount);
    if (facet.missing) params.set("facet.missing", "true");
  }

  const spatial = state.spatial;
  if (spatial.enabled) {
    set("pt", spatial.pt);
    set("sfield", spatial.sfield);
    set("d", spatial.d);
    // 官方 UI 的 geofilt/bbox 以 fq 函数查询注入
    if (spatial.geofilt) params.append("fq", "{!geofilt}");
    if (spatial.bbox) params.append("fq", "{!bbox}");
  }

  const sc = state.spellcheck;
  if (sc.enabled) {
    params.set("spellcheck", "true");
    set("spellcheck.q", sc.q);
    if (sc.build) params.set("spellcheck.build", "true");
    if (sc.collate) params.set("spellcheck.collate", "true");
    set("spellcheck.count", sc.count);
    set("spellcheck.dictionary", sc.dictionary);
    if (sc.onlyMorePopular) params.set("spellcheck.onlyMorePopular", "true");
  }

  for (const rp of state.rawParams) {
    if (nonEmpty(rp.key) && nonEmpty(rp.value)) params.append(rp.key.trim(), rp.value.trim());
  }

  return { text: `GET ${base}?${params.toString()}`, jsonMode: false };
}

/** /{core}/config/params 响应 → paramset 名列表，供 useParams 选择。 */
export function parseParamsetNames(body: unknown): string[] {
  const params = (body as Record<string, unknown> | null)?.response as Record<string, unknown> | undefined;
  const named = params?.params;
  if (!named || typeof named !== "object" || Array.isArray(named)) return [];
  return Object.keys(named as Record<string, unknown>).sort();
}

/** select 响应体 → numFound；非 select/出错为 null。 */
export function parseSolrNumFound(rawBody: string): number | null {
  try {
    const body = parseJsonPreservingLargeNumbers(rawBody) as Record<string, unknown> | null;
    const num = (body?.response as Record<string, unknown> | undefined)?.numFound;
    return typeof num === "number" ? num : null;
  } catch {
    return null;
  }
}

/* ---------- Overview（对标官方 UI：Statistics / Instance / Replication / Healthcheck 组合） ---------- */

/** luke ?show=index 的 index 块 → Statistics 行 */
export interface SolrIndexStats {
  lastModified?: string;
  numDocs?: number;
  maxDoc?: number;
  deletedDocs?: number;
  version?: number;
  segmentCount?: number;
  current?: boolean;
  /** Lucene Directory 实现类（org.apache.lucene.store.NRTCachingDirectory 等） */
  directoryImpl?: string;
}

export function parseIndexStats(body: unknown): SolrIndexStats {
  const index = (body as Record<string, unknown> | null)?.index as Record<string, unknown> | undefined;
  if (!index) return {};
  const directory = typeof index.directory === "string" ? index.directory : undefined;
  return {
    lastModified: index.lastModified as string | undefined,
    numDocs: typeof index.numDocs === "number" ? index.numDocs : undefined,
    maxDoc: typeof index.maxDoc === "number" ? index.maxDoc : undefined,
    deletedDocs: typeof index.deletedDocs === "number" ? index.deletedDocs : undefined,
    version: typeof index.version === "number" ? index.version : undefined,
    segmentCount: typeof index.segmentCount === "number" ? index.segmentCount : undefined,
    current: typeof index.current === "boolean" ? index.current : undefined,
    directoryImpl: directory?.split(":")[0],
  };
}

/** replication?command=details 的 details 块 */
export interface SolrReplicationDetails {
  isLeader: boolean;
  isFollower: boolean;
  indexSize?: string;
  indexPath?: string;
  indexVersion?: string;
  generation?: number;
  replicableVersion?: number;
  replicableGeneration?: number;
  replicationEnabled?: boolean;
  replicateAfter: string[];
  /** follower 侧信息（isLeader=false 时展示） */
  follower?: Record<string, unknown>;
}

export function parseReplicationDetails(body: unknown): SolrReplicationDetails | null {
  const details = (body as Record<string, unknown> | null)?.details as Record<string, unknown> | undefined;
  if (!details) return null;
  const leader = (details.leader ?? {}) as Record<string, unknown>;
  const follower = details.follower as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : v != null ? Number(v) : undefined);
  return {
    isLeader: details.isLeader === true || details.isLeader === "true",
    isFollower: details.isFollower === true || details.isFollower === "true",
    indexSize: details.indexSize as string | undefined,
    indexPath: details.indexPath as string | undefined,
    indexVersion: details.indexVersion != null ? String(details.indexVersion) : undefined,
    generation: num(details.generation),
    replicableVersion: num(leader.replicableVersion),
    replicableGeneration: num(leader.replicableGeneration),
    replicationEnabled: leader.replicationEnabled === true || leader.replicationEnabled === "true",
    replicateAfter: Array.isArray(leader.replicateAfter) ? leader.replicateAfter.map(String) : [],
    follower,
  };
}

/** leader 侧启停复制：/{core}/replication?command=enablereplication|disablereplication */
export function solrReplicationCommand(connectionId: string, core: string, command: "enablereplication" | "disablereplication"): Promise<SolrAdminResponse> {
  return solrAdminRequest(connectionId, "GET", `/${encodeURIComponent(core)}/replication?command=${command}`);
}

/** /admin/info/properties 响应 → JVM 工作目录（官方 Instance 框的 CWD）。 */
export function parseServerCwd(body: unknown): string | undefined {
  const props = (body as Record<string, unknown> | null)?.["system.properties"] as Record<string, unknown> | undefined;
  return typeof props?.["user.dir"] === "string" ? props["user.dir"] : undefined;
}

/* ---------- Dashboard（官方布局：Instance / Versions / JVM + System 进度条） ---------- */

export interface SolrSystemInfo {
  mode?: string;
  solrHome?: string;
  coreRoot?: string;
  /** jvm.jmx.startTime（ISO） */
  startTime?: string;
  uptimeMs?: number;
  solrSpec?: string;
  solrImpl?: string;
  luceneSpec?: string;
  luceneImpl?: string;
  /** name + version 拼接，如 "Eclipse Adoptium OpenJDK 64-Bit Server VM 17.0.15 17.0.15+6" */
  jvmRuntime?: string;
  processors?: number;
  args: string[];
  jvmMemUsedPct?: number;
  jvmMemUsed?: string;
  jvmMemTotal?: string;
  /** 物理内存：bytes */
  physMemUsedPct?: number;
  physMemUsed?: number;
  physMemTotal?: number;
  swapUsedPct?: number;
  swapUsed?: number;
  swapTotal?: number;
  fdUsed?: number;
  fdMax?: number;
}

export function parseSolrSystemInfo(body: unknown): SolrSystemInfo {
  const root = (body ?? {}) as Record<string, unknown>;
  const jvm = (root.jvm ?? {}) as Record<string, unknown>;
  const jmx = (jvm.jmx ?? {}) as Record<string, unknown>;
  const lucene = (root.lucene ?? {}) as Record<string, unknown>;
  const system = (root.system ?? {}) as Record<string, unknown>;
  const memory = (jvm.memory ?? {}) as Record<string, unknown>;
  const raw = (memory.raw ?? {}) as Record<string, unknown>;

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const pct = (used: number | undefined, total: number | undefined) => (used != null && total != null && total > 0 ? (used / total) * 100 : undefined);

  const physTotal = num(system.totalPhysicalMemorySize);
  const physFree = num(system.freePhysicalMemorySize);
  const physUsed = physTotal != null && physFree != null ? physTotal - physFree : undefined;
  const swapTotal = num(system.totalSwapSpaceSize);
  const swapFree = num(system.freeSwapSpaceSize);
  const swapUsed = swapTotal != null && swapFree != null ? swapTotal - swapFree : undefined;

  const jvmName = str(jvm.name);
  const jvmVersion = str(jvm.version);

  return {
    mode: str(root.mode),
    solrHome: str(root.solr_home),
    coreRoot: str(root.core_root),
    startTime: str(jmx.startTime),
    uptimeMs: num(jmx.upTimeMS),
    solrSpec: str(lucene["solr-spec-version"]),
    solrImpl: str(lucene["solr-impl-version"]),
    luceneSpec: str(lucene["lucene-spec-version"]),
    luceneImpl: str(lucene["lucene-impl-version"]),
    jvmRuntime: [jvmName, jvmVersion].filter(Boolean).join(" ") || undefined,
    processors: num(jvm.processors),
    args: Array.isArray(jmx.commandLineArgs) ? jmx.commandLineArgs.map(String) : [],
    jvmMemUsedPct: num(raw["used%"]),
    jvmMemUsed: str(memory.used),
    jvmMemTotal: str(memory.total),
    physMemUsedPct: pct(physUsed, physTotal),
    physMemUsed: physUsed,
    physMemTotal: physTotal,
    swapUsedPct: pct(swapUsed, swapTotal),
    swapUsed,
    swapTotal,
    fdUsed: num(system.openFileDescriptorCount),
    fdMax: num(system.maxFileDescriptorCount),
  };
}

/** solr-impl-version 里带构建日期（"9.8.1 dab835... - houston - 2025-03-06 13:59:17"），>1 年提示升级。 */
export function solrReleaseAgeDays(implVersion?: string): number | null {
  if (!implVersion) return null;
  const match = implVersion.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ts = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}
