import type { BackendError } from "@/lib/backend/errorUtils";
import type { TransferColumnNameCase, TransferContent, TransferMode, TransferObjectKind, TransferTableNameCase } from "@/lib/backend/tauri";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { MultiDbExecutionTarget, MultiDbResultRunExecution } from "@/types/sqlExecution";
import type { DatabaseType } from "@/types/generated/databaseTypes";
import type { PluginAiRecommendation } from "@/types/pluginAiRecommendations";
import type { GraphResult } from "@/lib/graph/graphResult";
import type { OracleRoutinePlanDraft } from "@/types/schemaDiff";

export type { DatabaseType } from "@/types/generated/databaseTypes";

export interface OracleViewRenameSourceInput {
  source: string;
  owner: string;
  viewName: string;
  oldName: string;
  newName: string;
  targetViewName?: string;
}

export interface OracleViewRenameSource {
  source: string;
  fingerprint: string;
  references: OracleViewRenameReference[];
}

export interface OracleViewRenameReference {
  owner: string;
  name: string;
}

export interface OracleViewRenameIssue {
  code: string;
  message: string;
  viewName?: string;
  hintText?: string | null;
  location?: { line: number; column: number; endLine?: number; endColumn?: number } | null;
  repairable: boolean;
}

export interface OracleViewRenameSourceReview {
  source: OracleViewRenameSource | null;
  references: OracleViewRenameReference[];
  issues: OracleViewRenameIssue[];
}

export interface OracleTableReferenceRewriteInput {
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle">;
  objectType: "PROCEDURE" | "FUNCTION" | "TRIGGER";
  schema: string;
  oldName: string;
  newName: string;
  source: string;
}

export function isElasticsearchCompatibleDatabaseType(dbType?: DatabaseType): boolean {
  return dbType === "elasticsearch" || dbType === "easysearch";
}

export function isMeilisearchDatabaseType(dbType?: DatabaseType): boolean {
  return dbType === "meilisearch";
}

export function isSolrDatabaseType(dbType?: DatabaseType): boolean {
  return dbType === "solr";
}

export function isCouchDbDatabaseType(dbType?: DatabaseType): boolean {
  return dbType === "couchdb";
}

export interface SqlSnippet {
  id: string;
  label: string;
  prefix: string;
  body: string;
  enabled?: boolean;
}

export type SqlShortcutKind = "template" | "select-limit";

export interface SqlShortcutAction {
  id: string;
  label: string;
  shortcut: string;
  sql: string;
  enabled?: boolean;
  /** Empty / omitted = all databases. Non-empty = only these DatabaseType values. */
  databaseTypes?: DatabaseType[];
  /** Per-database SQL overrides for custom templates; missing keys fall back to `sql`. */
  sqlByDatabaseType?: Partial<Record<DatabaseType, string>>;
  /** `select-limit` builds dialect-aware SELECT * … LIMIT/TOP/ROWNUM at run time (built-in only). */
  kind?: SqlShortcutKind;
  /** Row count for `select-limit` (default 10). Ignored for plain templates. */
  limit?: number;
}

export type CompletionAssistantObjectKind = "database" | "schema" | "table" | "view" | "routine" | "procedure" | "function" | "column" | "sequence";

export type CompletionAssistantCandidateKind = "database" | "schema" | "table" | "view" | "procedure" | "function" | "column" | "sequence" | "object";

export type CompletionAssistantMatchMode = "prefix" | "contains";

export interface CompletionAssistantRequest {
  connection_id: string;
  database: string;
  schema?: string | null;
  object_kinds?: CompletionAssistantObjectKind[];
  mask?: string;
  case_sensitive?: boolean;
  global_search?: boolean;
  max_results?: number | null;
  search_in_comments?: boolean;
  search_in_definitions?: boolean;
  parent_schema?: string | null;
  parent_name?: string | null;
  parent_type?: "package" | "type" | null;
  match_mode?: CompletionAssistantMatchMode | null;
}

export interface CompletionAssistantCandidate {
  name: string;
  kind: CompletionAssistantCandidateKind;
  database?: string | null;
  schema?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
  comment?: string | null;
  data_type?: string | null;
  signature?: string | null;
  routine_id?: string | null;
}

export interface CompletionAssistantResponse {
  candidates: CompletionAssistantCandidate[];
  incomplete: boolean;
  fallback_used: boolean;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  /** Read-only response identity retained when a saved JDBC URL is protected. */
  readonly jdbc_dialect?: "oceanbase-oracle";
  note?: string;
  db_type: DatabaseType;
  driver_profile?: string;
  driver_label?: string;
  url_params?: string;
  agent_java_options?: string[];
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  default_schema?: string;
  visible_databases?: string[];
  visible_database_patterns?: string[];
  visible_schemas?: Record<string, string[]>;
  show_system_schemas?: boolean;
  /** Connection-level sidebar display preferences. Absent means shown. */
  show_database_links?: boolean;
  show_native_jobs?: boolean;
  show_user_admin?: boolean;
  /** Load every page when the sidebar's Tables group is opened for this connection. */
  sidebar_auto_load_all_tables?: boolean;
  attached_databases?: AttachedDatabaseConfig[];
  init_script?: string;
  color?: string;
  /**
   * Where this connection's documentation notes are stored. Absent means the
   * per-connection default inside the app data directory; an explicit path
   * lets the notes file live in a repository and be reviewed in pull requests.
   */
  docs_notes_path?: string;
  transport_layers?: TransportLayerConfig[];
  connect_timeout_secs?: number;
  connect_timeout_inherit?: boolean;
  query_timeout_secs?: number;
  query_timeout_inherit?: boolean;
  idle_timeout_secs?: number;
  /** Seconds a manual transaction may sit idle before DBX rolls it back. */
  manual_transaction_timeout_secs?: number;
  /**
   * 空闲自动断开阈值（秒）：后端在连接池层面实现，连接在此秒数内无任何查询活动时自动关闭其
   * 连接池；前端据此把连接标记为未连接并保留已打开的页签与结果，供用户下次操作时自动重连。
   *
   * 0（默认）表示不启用。与 `idle_timeout_secs` 语义不同：后者只回收连接池内的空闲物理连接，
   * 不会关闭整个连接池；本字段关闭的是整个连接池。所有方言均适用（与方言无关）。
   */
  idle_disconnect_secs?: number;
  keepalive_interval_secs?: number;
  ssl?: boolean;
  ca_cert_path?: string;
  client_cert_path?: string;
  client_key_path?: string;
  sysdba?: boolean;
  oracle_connection_type?: "service_name" | "sid" | "tns";
  /** Connection-level NLS_LANG override; empty follows the global default. */
  oracle_oci_nls_lang?: string;
  /**
   * Connection-level TNS_ADMIN override for OCI (tnsnames.ora / sqlnet.ora /
   * wallet directory); empty follows the global default.
   */
  oracle_oci_tns_admin?: string;
  connection_string?: string;
  jdbc_driver_class?: string;
  jdbc_driver_paths?: string[];
  redis_connection_mode?: "standalone" | "sentinel" | "cluster";
  redis_sentinel_master?: string;
  redis_sentinel_nodes?: string;
  redis_sentinel_username?: string;
  redis_sentinel_password?: string;
  redis_sentinel_tls?: boolean;
  redis_cluster_nodes?: string;
  redis_key_separator?: string;
  redis_scan_page_size?: number;
  redis_database_aliases?: Record<string, string>;
  /** Key-search templates for the Redis browser. Non-empty overrides global settings. */
  redis_key_templates?: string[];
  /** Default Redis glob pattern applied when opening a new key-browser tab. */
  redis_key_filter?: string;
  redis_key_grouping?: import("@/lib/redis/redisKeyGrouping").RedisKeyGrouping;
  etcd_endpoints?: string;
  gbase_server?: string;
  informix_server?: string;
  external_config?: unknown;
  plugin_id?: string;
  plugin_connection_provider?: string;
  plugin_connection_type?: string;
  connection_secrets?: Record<string, string>;
  one_time?: boolean;
  /**
   * Whether the database password may be persisted locally. When false, the
   * password is never written to local storage and the user is prompted on
   * every connect. Absent/true keeps current behavior (password saved).
   */
  save_password?: boolean;
  read_only?: boolean;
  /** Explicit production marker for every database reachable through this connection. */
  is_production?: boolean;
  /** Database-level production markers for multi-database connections. */
  production_databases?: string[];
  /** Sidebar presentation only; absent means database/schema rows plus sticky context. */
  production_badge_scope?: ProductionBadgeScope;
  /** Metadata captured from the latest successful connection test for the saved config. */
  database_info?: DatabaseConnectionInfo;
}

export type ProductionBadgeScope = "connection" | "database" | "table";

export type IdentifierCase = "lower" | "upper" | "mixed";

export interface DatabaseConnectionInfo {
  compatibilityMode?: string;
  productName?: string;
  productVersion?: string;
  currentDatabase?: string;
  serverComment?: string;
  serverCharset?: string;
  serverCollation?: string;
  unquotedIdentifierCase?: IdentifierCase;
  quotedIdentifierCase?: IdentifierCase;
  driverName?: string;
  driverVersion?: string;
  jdbcVersion?: string;
}

export interface ConnectionTestResult {
  message: string;
  databaseInfo?: DatabaseConnectionInfo;
}

/**
 * Why the backend declared a connection's pools dead while the app was idle (#4339).
 * A stable enum by design: raw driver/network error text must not reach a background
 * UI notification.
 */
export type ConnectionLivenessFailureKind = "probe_failed" | "timed_out";

/**
 * A message on the backend connection-liveness channel (#4339).
 *
 * Mirrors the Rust `ConnectionLivenessMessage`, and both transports deliver this exact shape:
 * the desktop shell forwards it unwrapped and the web SSE stream sends the object itself, so
 * there is no envelope beyond the message's own `kind` discriminator.
 *
 * `resync` means the transport skipped messages, so the frontend must re-check every
 * connection it still shows as connected — without it, a dropped `lost` would leave a
 * sidebar green indefinitely.
 */
export type ConnectionLivenessMessage = { kind: "lost"; connectionId: string; failureKind: ConnectionLivenessFailureKind } | { kind: "resync" };

/**
 * 后端「空闲自动断开」事件（`dbx:connection-idle-closed`）的载荷：某个连接的连接池因空闲
 * 超过 `idle_disconnect_secs` 被后端自动关闭。前端收到后把该连接标记为未连接并保留页签。
 *
 * `closedAtMs` 是后端关闭时的墙钟时间（Unix 毫秒）：事件通道可能有缓冲，若本连接在事件
 * 到达之前已经重新建立，说明这次断开描述的是上一个会话，前端必须忽略，否则会关掉新会话。
 */
export type ConnectionIdleClosedEvent = { connectionId: string; closedAtMs?: number };

export type TransportLayerConfig = ({ type: "ssh" } & SshTunnelConfig) | ({ type: "proxy" } & ProxyTunnelConfig) | ({ type: "http_tunnel" } & HttpTunnelConfig);

/**
 * A shared tunnel configuration managed in Settings > Tunnels. Structurally a
 * `TransportLayerConfig`; its `id` is what connection layers reference via
 * `profile_id`. Edits to a profile apply to every referencing connection the
 * next time it connects.
 */
export type TunnelProfile = TransportLayerConfig;

export interface SshTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  host: string;
  port: number;
  user: string;
  password?: string;
  key_path?: string;
  key_passphrase?: string;
  connect_timeout_secs?: number;
  expose_lan?: boolean;
  /**
   * Fixed local port (1-65535) the tunnel listens on while the connection is
   * open, so other local tools can reuse it. Only the last enabled layer uses
   * it, and only when it is an inline SSH layer (not a shared tunnel profile).
   * Absent means a random free port. It binds `0.0.0.0` instead of `127.0.0.1`
   * when `expose_lan` is on.
   */
  local_port?: number;
  use_ssh_agent?: boolean;
  ssh_agent_sock_path?: string;
  /**
   * SHA-256 fingerprint (`SHA256:...`) of the one SSH agent identity to use.
   * Empty means every identity the agent reports is tried, in order.
   */
  ssh_agent_key_fingerprint?: string;
  /**
   * UI-facing choice of login method. Drives which credential inputs the
   * connection dialog shows; the backend still probes "none" then falls
   * back to key > password > agent based on which fields are non-empty,
   * independent of this selector (see `db/ssh_tunnel.rs`).
   *
   * `"key+password"` tries private key auth first and falls back to
   * password auth if the key is rejected.
   *
   * `"agent"` uses identities from the configured SSH agent socket.
   */
  auth_method?: "password" | "key" | "key+password" | "agent" | "none";
  /** Allow `nc` through an SSH exec channel when direct-tcpip is prohibited. */
  allow_exec_channel_proxy?: boolean;
  /**
   * OpenSSH-style `ProxyCommand` used to reach this host instead of a direct
   * TCP connection, e.g. `nc %h %p` or
   * `cloudflared access ssh --hostname %h`. `%h`/`%p`/`%r`/`%%` expand from
   * the effective host, port and user. The executable must be one of the
   * helpers the backend allowlists (`nc`, `ncat`, `netcat`, `cloudflared`,
   * `socat`, `connect`, `corkscrew`, `ssh`). Empty means a direct connection.
   */
  proxy_command?: string;
  /**
   * When set, this layer references a shared tunnel profile; the profile's
   * configuration replaces this layer's fields at connect time (only `id`
   * and `enabled` are kept).
   */
  profile_id?: string;
}

export interface SshAgentIdentity {
  fingerprint: string;
  algorithm: string;
  comment: string;
}

export interface SshConfigHostEntry {
  alias: string;
  host_name?: string;
  port?: number;
  user?: string;
  identity_file?: string;
  proxy_command?: string | null;
}

export interface ProxyTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  proxy_type?: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Optional target host:port for tunnel testing. When empty, self-connect. */
  test_target?: string;
  /** See {@link SshTunnelConfig.profile_id}. */
  profile_id?: string;
}

export interface HttpTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  url: string;
  token?: string;
  protocol?: "dbx_tcp" | "navicat_mysql";
  connect_timeout_secs?: number;
  /** See {@link SshTunnelConfig.profile_id}. */
  profile_id?: string;
}

export interface AttachedDatabaseConfig {
  name: string;
  path: string;
}

export interface PluginDriverManifest {
  id: string;
  label: string;
  kind: string;
  database_type?: string;
}

export interface PluginCapabilityManifest {
  id: string;
  label: string;
  kind?: string;
}

export type PluginFormFieldType = "text" | "password" | "number" | "boolean" | "select" | "radio" | "textarea";
export type PluginFormFieldBinding = "config" | "secret" | "name" | "host" | "port" | "username" | "password" | "database";

export type PluginFormFieldValue = string | number | boolean | undefined;

export interface LocalSshKey {
  /** Absolute path to the private key file. */
  path: string;
  /** SSH algorithm name (e.g. `ssh-ed25519`); empty when undetectable. */
  algorithm: string;
  /** SHA-256 fingerprint (`SHA256:...`); empty when the key could not be decoded. */
  fingerprint: string;
  /** Heuristic: the key looks passphrase-protected. */
  hasPassphrase: boolean;
}

export interface PluginFormFieldOption {
  label: string;
  value: string;
}

/** A literal a `one_of` clause may list; compared by canonical string form. */
export type PluginFieldConditionLiteral = string | number | boolean;

/** Legacy single-field clause: `{ field, one_of }`. */
export interface PluginFieldConditionClause {
  /** Key of another plugin form field whose current value drives the clause. */
  field: string;
  /** The clause matches when the referenced field's value is in this list. */
  one_of: PluginFieldConditionLiteral[];
}

/** Every nested condition must match. */
export interface PluginFieldConditionAllOf {
  all_of: PluginFieldCondition[];
}

/** At least one nested condition must match. */
export interface PluginFieldConditionAnyOf {
  any_of: PluginFieldCondition[];
}

/** Inverts the nested condition. */
export interface PluginFieldConditionNot {
  not: PluginFieldCondition;
}

/** Host API 1.1: local-file action on a plugin connection field. */
export interface PluginFormFieldPicker {
  /** `directory` is desktop-only. */
  kind: "file" | "directory";
  /** Extensions (`.pem`) or MIME types (`text/plain`) offered by the picker. */
  accept?: string[];
  /**
   * Declared sibling field that receives the file content on hosts without a
   * client filesystem (the browser build). Desktop hosts store the chosen path
   * in the declaring field and clear this one instead.
   */
  content_field?: string;
}

/**
 * `visible_when` / `required_when` expression. The legacy `{ field, one_of }`
 * clause keeps its exact meaning; `all_of` / `any_of` / `not` compose clauses
 * (e.g. `sudo_source = custom AND read_only = false`).
 */
export type PluginFieldCondition = PluginFieldConditionClause | PluginFieldConditionAllOf | PluginFieldConditionAnyOf | PluginFieldConditionNot;

export interface PluginFormField {
  key: string;
  label: string;
  type: PluginFormFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** Declared default. Hosts older than the manifest serialization fix send
   * `null` for "no default", which the form treats as unset. */
  default?: PluginFormFieldValue | null;
  options?: PluginFormFieldOption[];
  /** Plugin method returning `{ options: [{ value, label }] }` for dynamic
   * select rendering; the host calls it with `{ locale }` (the current DBX UI
   * locale) so plugins can localize the labels. Falls back to the declared
   * type when unavailable. */
  options_action?: string;
  /** Host API 1.1: offer a local-file action on this field. */
  picker?: PluginFormFieldPicker;
  binding?: PluginFormFieldBinding;
  visible_when?: PluginFieldCondition;
  required_when?: PluginFieldCondition;
}

export type PluginConnectionCapability = "test" | "connect" | "disconnect";
export type PluginConnectionActionKind = "test" | "save" | "save-and-connect" | "custom";
export type PluginConnectionActionVariant = "default" | "outline" | "secondary" | "destructive" | "ghost";
export type PluginConnectionActionWhen = "always" | "create" | "edit";

export interface PluginConnectionActionContribution {
  id: string;
  label: string;
  description?: string;
  variant?: PluginConnectionActionVariant;
  when?: PluginConnectionActionWhen;
  close_on_success?: boolean;
  requires_valid_form?: boolean;
  timeout_ms?: number;
}

export interface PluginConnectionAction {
  id: string;
  kind: PluginConnectionActionKind;
  label?: string;
  description?: string;
  variant?: PluginConnectionActionVariant;
  when?: PluginConnectionActionWhen;
  close_on_success?: boolean;
  requires_valid_form?: boolean;
  timeout_ms?: number;
}

export interface PluginConnectionProviderContribution {
  type: "connection-provider";
  id: string;
  label: string;
  icon?: string;
  database_type: string;
  description?: string;
  fields: PluginFormField[];
  workbench?: string;
  filesystem_provider?: string;
  capabilities?: PluginConnectionCapability[];
  actions?: PluginConnectionActionContribution[];
  /** Multi-endpoint providers (Kafka advertised.listeners) receive a SOCKS5 runtime.proxy route over transport layers. */
  proxy_route?: boolean;
}

export interface PluginWorkbenchContribution {
  type: "workbench";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  ai?: PluginWorkbenchAiContribution;
}

export interface PluginWorkbenchAiContribution {
  recommendations?: PluginAiRecommendation[];
}

export interface PluginFilesystemProviderContribution {
  type: "filesystem-provider";
  id: string;
  label: string;
  schemes: string[];
  description?: string;
  icon?: string;
  root_uri?: string;
  capabilities?: Array<"read" | "write" | "delete" | "rename" | "mkdir">;
}

export type PluginFilesystemEntryKind = "file" | "directory" | "symlink" | "other";

export interface PluginFilesystemEntry {
  name: string;
  uri: string;
  kind: PluginFilesystemEntryKind;
  size?: number;
  modifiedAt?: string;
  contentType?: string;
}

export interface PluginFilesystemListResult {
  entries: PluginFilesystemEntry[];
  nextCursor?: string;
}

export interface PluginFilesystemReadResult {
  dataBase64: string;
  contentType?: string;
  truncated: boolean;
  etag?: string;
}

export interface PluginFilesystemMutationResult {
  success: boolean;
  message?: string;
  entry?: PluginFilesystemEntry;
}

export type PluginContextMenuTarget = "connection" | "table";

export interface PluginTableContext {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

export interface PluginContextMenuContribution {
  type: "context-menu";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  menu: PluginContextMenuTarget;
  dynamic?: boolean;
  action?: PluginOpenWorkbenchTarget;
}

export interface PluginResultViewContribution {
  type: "result-view";
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

export type PluginCommandPresentation = "tab" | "panel";
export type PluginCommandReuse = "singleton" | "new";
export type PluginCommandRestore = "none";

/** Shared wire-level navigation contract used by commands and context-menu contributions. */
export interface PluginOpenWorkbenchTarget {
  type: "open-workbench";
  /** Workbench contribution of the SAME plugin. */
  workbench: string;
}

/** v1 command action extends the shared target with command-specific launch behavior. */
export interface PluginOpenWorkbenchAction extends PluginOpenWorkbenchTarget {
  presentation?: PluginCommandPresentation;
  reuse?: PluginCommandReuse;
  instance_key?: string;
  restore?: PluginCommandRestore;
  /** Opaque plugin payload; the host serves it under `context.plugin`. */
  context?: Record<string, unknown>;
  /**
   * Generic launch-options extension point: sidecar method returning
   * `{ entries: [{ label, description?, context? }] }` for the dock "+" picker.
   * The host calls it with `{ locale }` (the current DBX UI locale, e.g.
   * "en"/"zh-CN") so plugins can localize the returned labels, renders the
   * labels and merges the chosen context into the host-authored panel
   * context — never interpreting the business meaning.
   */
  options_action?: string;
  /** When true, the host also offers the plugin's own saved connections as launch targets. */
  connection_targets?: boolean;
}

export type PluginConditionOperator = "equals" | "notEquals" | "oneOf";

/** §5.3 structured condition clause; key/operator are host-reserved word lists — unknown values were rejected at parse time. */
export interface PluginConditionClause {
  key: string;
  operator: PluginConditionOperator;
  value: string | boolean | string[];
}

/** enablement/when condition group: implicit AND within `all`; absent field defaults to true. */
export interface PluginCommandEnablement {
  all: PluginConditionClause[];
}

/** Context-key snapshot for condition evaluation (host-provided per scenario; clauses referencing a missing key are always false). */
export type PluginConditionContextKeys = Record<string, string | boolean | undefined>;

export interface PluginCommandLaunchOption {
  label: string;
  description?: string;
  context?: Record<string, unknown>;
}

export interface PluginCommandContribution {
  type: "command";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  action: PluginOpenWorkbenchAction;
  enablement?: PluginCommandEnablement;
}

export type PluginMenuLocation = "commandPalette" | "appToolbar" | "appSidebar";

export interface PluginMenuItem {
  location: PluginMenuLocation;
  /** Short command id of the SAME plugin. */
  command: string;
  group: string;
  order: number;
  /** Toolbar entries default to hidden; sidebar entries default to visible. */
  default_visible?: boolean;
  /** Placement visibility condition (defaults to true); evaluated independently from command.enablement. */
  when?: PluginCommandEnablement;
}

export interface PluginMenusContribution {
  type: "menus";
  id: string;
  items: PluginMenuItem[];
}

/**
 * Declares that the plugin sidecar speaks the optional MCP tool bridge
 * (`mcp/tools` + `mcp/call`) and opts its tools into the host's automatic
 * surfaces: the built-in AI agent and the external `dbx` MCP server. Both
 * default to true; the Plugin Center switch still overrides the AI surface.
 */
export interface PluginMcpContribution {
  type: "mcp";
  id: string;
  description?: string;
  ai_tools?: boolean;
  external_tools?: boolean;
  /** Optional grouping of the plugin's tools for the MCP settings UI. */
  toolsets?: Array<{ id: string; title: string; description?: string }>;
  /** Optional per-tool declarations keyed by tool name. */
  tools?: Record<string, { toolset?: string; access?: "read" | "write" | "full" }>;
  /** Optional sub-scope below a connection (e.g. a Kubernetes namespace). */
  scope?: { kind: string; title: string; argument: string; list_method?: string };
}

/**
 * Contribution types the host renders through the plugin's own UI entrypoint in
 * a plugin tab. A `workbench` is launched from the sidebar, the plugin center,
 * or `host.openWorkbench`; a `result-view` is launched from the query-result
 * toolbar with the current result snapshot as context. Both declare display
 * metadata only — the opened contribution id is what tells the plugin UI which
 * of its declared surfaces to render.
 */
export type PluginUiContribution = PluginWorkbenchContribution | PluginResultViewContribution;

export type PluginContribution = PluginConnectionProviderContribution | PluginWorkbenchContribution | PluginFilesystemProviderContribution | PluginContextMenuContribution | PluginResultViewContribution | PluginCommandContribution | PluginMenusContribution | PluginMcpContribution;

export interface PluginEngines {
  dbx: string;
  host_api: string;
}

export interface PluginBackendEntrypoint {
  protocol_versions?: number[];
  transport?: "stdio-jsonl" | "stdio-framed";
  executable: string;
}

export interface PluginUiEntrypoint {
  root?: string;
  entry: string;
}

export interface PluginEntrypoints {
  backend?: PluginBackendEntrypoint;
  ui?: PluginUiEntrypoint;
}

export interface PluginFormFieldLocalization {
  label?: string;
  description?: string;
  placeholder?: string;
  options?: Record<string, string>;
}

export interface PluginContributionLocalization {
  label?: string;
  description?: string;
  fields?: Record<string, PluginFormFieldLocalization>;
  actions?: Record<string, { label?: string; description?: string }>;
}

export interface PluginManifestLocalization {
  name?: string;
  description?: string;
  contributions?: Record<string, PluginContributionLocalization>;
}

export interface PluginCompatibility {
  compatible: boolean;
  errors?: string[];
  warnings?: string[];
  target?: string;
}

export interface PluginManifest {
  manifest_version?: number;
  id: string;
  name: string;
  icon?: string;
  version?: string;
  publisher?: string;
  engines?: PluginEngines;
  permissions?: string[];
  entrypoints?: PluginEntrypoints;
  protocol_version?: number;
  description?: string;
  source?: string;
  homepage?: string;
  executable?: string;
  drivers: PluginDriverManifest[];
  capabilities?: PluginCapabilityManifest[];
  contributions?: PluginContribution[];
  localizations?: Record<string, PluginManifestLocalization>;
}

export interface PluginInstallProvenance {
  repositoryId?: string;
  publisher?: string;
  signingKeyId?: string;
  source?: "marketplace" | "url" | "file" | "unknown";
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  compatibility: PluginCompatibility;
  path?: string;
  provenance?: PluginInstallProvenance;
}

export interface PluginTrustedKey {
  keyId: string;
  publicKey: string;
}

export type PluginRepositoryKind = "official" | "custom" | "enterprise";

export interface PluginRepository {
  id: string;
  name: string;
  kind: PluginRepositoryKind;
  catalogUrl?: string;
  enabled: boolean;
  managed: boolean;
}

export interface PluginMarketplaceRepositoryMetadata {
  id: string;
  name: string;
  homepage?: string;
}

export interface PluginMarketplaceLocalization {
  name?: string;
  description?: string;
}

export interface PluginMarketplaceArtifact {
  target: string;
  url: string;
  sha256: string;
  signingKeyId: string;
  size?: number;
}

export interface PluginMarketplaceVersion {
  version: string;
  releasedAt?: string;
  releaseNotes?: string;
  artifacts: PluginMarketplaceArtifact[];
}

export interface PluginMarketplacePlugin {
  id: string;
  name: string;
  description: string;
  publisher: string;
  verified: boolean;
  icon?: string;
  tags: string[];
  permissions: string[];
  /** The plugin provides MCP tools (manifest declares an `mcp` contribution). */
  mcpTools?: boolean;
  source?: string;
  homepage?: string;
  license?: string;
  latestVersion: string;
  versions: PluginMarketplaceVersion[];
  localizations?: Record<string, PluginMarketplaceLocalization>;
}

export interface PluginMarketplaceCatalog {
  catalogVersion: number;
  repository: PluginMarketplaceRepositoryMetadata;
  generatedAt?: string;
  plugins: PluginMarketplacePlugin[];
}

export interface PluginRepositoryCatalogResult {
  repository: PluginRepository;
  target: string;
  catalog?: PluginMarketplaceCatalog;
  error?: string;
}

export interface PluginMarketplaceInstallRequest {
  repositoryId: string;
  pluginId: string;
  version?: string;
  allowSourceChange?: boolean;
}

export interface ActivePluginSession {
  pluginId: string;
  processId?: number;
  state: "starting" | "running" | "stopping" | "stopped" | "exited";
}

export interface PluginUiAssetPayload {
  contentType: string;
  dataBase64: string;
  etag: string;
}

export interface PluginConnectionActionResult {
  message?: string;
  fieldValues?: Record<string, PluginFormFieldValue | null>;
}

export interface PluginInstallResult {
  plugin: InstalledPlugin;
  previousVersion?: string;
  packageSha256: string;
  signature: { status: "trusted"; key_id: string } | { status: "unsigned" };
}

export interface PluginRollbackResult {
  plugin: InstalledPlugin;
  previousVersion: string;
}

export interface PluginEvent {
  pluginId: string;
  method: string;
  params: unknown;
}

export interface PluginBinaryEvent {
  pluginId: string;
  channel: string;
  dataBase64: string;
}

export interface JdbcDriverInfo {
  name: string;
  path: string;
  size: number;
  bundle_id?: string | null;
}

export interface JdbcMavenArtifactInfo {
  group_id: string;
  artifact_id: string;
  version: string;
  classifier: string;
  extension: string;
  file_name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface JdbcMavenBundleInfo {
  id: string;
  coordinate: string;
  scope: string;
  repositories: string[];
  installed_at: string;
  path: string;
  artifacts: JdbcMavenArtifactInfo[];
}

export interface JdbcLocalArtifactInfo {
  file_name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface JdbcLocalBundleInfo {
  id: string;
  name: string;
  installed_at: string;
  path: string;
  artifacts: JdbcLocalArtifactInfo[];
}

export interface JdbcPluginStatus {
  installed: boolean;
  version?: string | null;
  protocol_version?: number | null;
  compatible: boolean;
  latest_version?: string | null;
  latest_protocol_version?: number | null;
  update_available: boolean;
  path: string;
}

export interface DatabaseInfo {
  name: string;
  size_bytes?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  comment?: string | null;
  default_charset?: string | null;
  default_collation?: string | null;
  /** Database-level compatibility mode, for example openGauss A/B/C/PG. */
  compatibility_mode?: string | null;
}

export interface DatabaseStorageInfo {
  name: string;
  size_bytes: number | null;
}

export interface XuguDatafileInfo {
  node_id: string;
  space_id: number;
  path: string;
  file_no: number;
  max_size?: number | null;
  step_size?: number | null;
  curr_size?: number | null;
  reserved1?: string | null;
}

export interface XuguTablespaceInfo {
  node_id: string;
  space_id: number;
  space_name: string;
  datafile_num: number;
  space_type: string;
  media_error?: string | null;
  total_chunk_num?: number | null;
  free_chunk_num?: number | null;
  datafiles: XuguDatafileInfo[];
}

export interface SqlServerCompletionContext {
  default_schema: string;
  supports_session_database_switch: boolean;
}

export interface SchemaInfo {
  name: string;
  comment?: string | null;
}

export interface LinkedServerInfo {
  name: string;
  product?: string | null;
  provider?: string | null;
  data_source?: string | null;
}

/** A catalog exposed by a multi-catalog engine (Doris / StarRocks). */
export interface CatalogInfo {
  name: string;
  catalog_type: string;
  is_current: boolean;
  comment?: string | null;
}

export interface TableInfo {
  name: string;
  table_type: string;
  /** Optional validity populated by status-aware object loaders. */
  valid?: boolean | null;
  comment?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
}

export type DatabaseObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT" | "SEQUENCE" | "SYNONYM" | "JOB" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";

export interface ObjectInfo {
  name: string;
  object_type: DatabaseObjectType | string;
  schema?: string | null;
  valid?: boolean | null;
  signature?: string | null;
  custom_type_kind?: CustomTypeKind | null;
  has_members?: boolean | null;
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
  trigger?: TriggerInfo | null;
  xugu_type_members_expandable?: boolean | null;
  /** Xugu package metadata merged from the PACKAGE_BODY catalog row. */
  xugu_package_body_available?: boolean | null;
  xugu_package_body_valid?: boolean | null;
}

export interface ObjectStatistics {
  name: string;
  schema?: string | null;
  estimated_rows?: number | null;
  total_bytes?: number | null;
  data_length?: number | null;
  engine?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  collation?: string | null;
  row_format?: string | null;
  avg_row_length?: number | null;
  max_data_length?: number | null;
  check_time?: string | null;
  index_length?: number | null;
  auto_increment?: string | null;
  data_free?: number | null;
}

export type ObjectSourceKind = "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT" | "SEQUENCE" | "SYNONYM" | "JOB" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";

export type RoutineParameterMetadataMode = "IN" | "OUT" | "INOUT" | "RETURN" | "UNKNOWN";

export interface RoutineParameterMetadata {
  name?: string | null;
  mode: RoutineParameterMetadataMode;
  jdbc_type?: number | null;
  type_name?: string | null;
  precision?: number | null;
  length?: number | null;
  scale?: number | null;
  nullable?: boolean | null;
  ordinal?: number | null;
}

export interface ObjectSource {
  name: string;
  object_type: ObjectSourceKind;
  schema?: string | null;
  source: string;
  editable?: boolean;
  /** Optional structured metadata exposed by generic JDBC sidecars. */
  routine_parameters?: RoutineParameterMetadata[];
  trigger?: TriggerInfo | null;
}

export interface MysqlEventInfo {
  name: string;
  schema: string;
  definer?: string | null;
  time_zone?: string | null;
  event_type?: string | null;
  execute_at?: string | null;
  interval_value?: string | null;
  interval_field?: string | null;
  starts?: string | null;
  ends?: string | null;
  status?: string | null;
  on_completion?: string | null;
  comment?: string | null;
  event_body?: string | null;
  event_definition?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_executed?: string | null;
  source?: string | null;
}

export type CustomTypeKind = "base" | "composite" | "domain" | "enum" | "range" | "multirange" | "object" | "collection" | "other";

export interface CustomTypeMember {
  name: string;
  dataType: string;
  ordinal: number;
  nullable?: boolean | null;
  default?: string | null;
  comment?: string | null;
  enumValue?: string | null;
}

export interface CustomTypeDomainConstraint {
  name: string;
  definition: string;
}

export interface CustomTypeProperties {
  baseType?: string | null;
  notNull?: boolean | null;
  default?: string | null;
  collation?: string | null;
  domainConstraints: CustomTypeDomainConstraint[];
  rangeSubtype?: string | null;
  rangeMultirangeName?: string | null;
  rangeCanonicalFunction?: string | null;
  rangeSubtypeDiffFunction?: string | null;
  rangeSubtypeOpclass?: string | null;
  inputFunction?: string | null;
  outputFunction?: string | null;
  receiveFunction?: string | null;
  sendFunction?: string | null;
  analyzeFunction?: string | null;
  internallength?: number | null;
  passedByValue?: boolean | null;
  alignment?: string | null;
  storage?: string | null;
}

export interface CustomTypeDdl {
  sql: string;
  complete: boolean;
  warnings?: string[];
}

export interface TypeMetadataRead {
  state: "available" | "incomplete" | "unavailable" | "unsupported";
  reason?: string | null;
}

export interface OracleTypeAttribute {
  name: string;
  ordinal?: number | null;
  typeOwner?: string | null;
  typeName?: string | null;
  typeModifier?: string | null;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
}

export interface OracleTypeMethodParameter {
  name?: string | null;
  ordinal?: number | null;
  mode?: string | null;
  typeOwner?: string | null;
  typeName?: string | null;
  typeModifier?: string | null;
}

export interface OracleTypeMethod {
  name: string;
  number?: number | null;
  kind?: string | null;
  parameterCount?: number | null;
  resultCount?: number | null;
  parameters: OracleTypeMethodParameter[];
  results: OracleTypeMethodParameter[];
  parametersRead: TypeMetadataRead;
  resultsRead: TypeMetadataRead;
}

export interface OracleTypeCollection {
  kind?: string | null;
  upperBound?: number | null;
  elementOwner?: string | null;
  elementName?: string | null;
  elementModifier?: string | null;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
}

export interface OracleTypeMetadata {
  status?: string | null;
  typeCode?: string | null;
  isFinal?: boolean | null;
  instantiable?: boolean | null;
  supertypeOwner?: string | null;
  supertypeName?: string | null;
  attributeCount?: number | null;
  methodCount?: number | null;
  bodyVisible?: boolean | null;
  bodyStatus?: string | null;
  propertiesRead: TypeMetadataRead;
  bodyRead: TypeMetadataRead;
  attributesRead: TypeMetadataRead;
  methodsRead: TypeMetadataRead;
  collectionRead: TypeMetadataRead;
  attributes: OracleTypeAttribute[];
  methods: OracleTypeMethod[];
  collection?: OracleTypeCollection | null;
}

export interface CustomTypeDetails {
  name: string;
  schema: string;
  kind: CustomTypeKind;
  comment?: string | null;
  members: CustomTypeMember[];
  properties: CustomTypeProperties;
  ddl?: CustomTypeDdl | null;
  oracleMetadata?: OracleTypeMetadata | null;
}

export interface TypeRecoveryContext {
  planId: string;
  stepId: string;
}

export interface TypeExecutionBinding extends TypeRecoveryContext {
  executionId: string;
  connectionId: string;
  database: string;
  schema: string | null;
  sql: string;
}

export interface OracleTypeManagementTarget {
  connectionId: string;
  database: string;
  owner: string;
  name: string;
}

export interface OracleTypeManagementObjectKey {
  owner: string;
  name: string;
  objectType: string;
}

export interface OracleTypeDataRelationKey {
  owner: string;
  name: string;
}
export interface OracleTypeDataField {
  sourcePath: string[];
  objectNull: boolean;
  oldColumn: string;
  expectedColumn: string;
  targetPath: string[];
  targetObjectNull?: boolean;
  unchanged: boolean;
}
export interface OracleTypeDataMappingInput {
  id: string;
  source: OracleTypeDataRelationKey;
  old: OracleTypeDataRelationKey;
  expected: OracleTypeDataRelationKey;
  target: OracleTypeDataRelationKey;
  fields: OracleTypeDataField[];
}
export interface OracleTypeDataProjection {
  path: string[];
  objectNull: boolean;
  dataType: string;
}
export interface OracleTypeDataRelation {
  relation: OracleTypeDataRelationKey;
  objectId: string;
  readOnly: boolean | null;
  structure: string;
  projection: OracleTypeDataProjection[];
}
export interface OracleTypeDataBaseline {
  relation: OracleTypeDataRelation;
  rowCount: number;
  fingerprint: string;
}
export interface OracleTypeDataManifest {
  mapping: OracleTypeDataMappingInput;
  original: OracleTypeDataBaseline;
  old: OracleTypeDataBaseline;
  expected: OracleTypeDataBaseline;
  preparedTarget?: OracleTypeDataBaseline | null;
  verifiedTarget?: OracleTypeDataBaseline | null;
}
export interface OracleTypeDataRequest {
  target: OracleTypeManagementTarget;
  action: "describe" | "register" | "verify" | "validate_insert";
  relation?: OracleTypeDataRelationKey;
  mapping?: OracleTypeDataMappingInput;
  manifest?: OracleTypeDataManifest;
  sql?: string;
}
export interface OracleTypeDataResult {
  relation?: OracleTypeDataRelation | null;
  manifest?: OracleTypeDataManifest | null;
  insertSql?: string | null;
}

/** Database-native evolution keeps data in place. These guards contain no row values. */
export interface OracleTypeEvolutionManifest {
  target: OracleTypeManagementTarget;
  sourceBefore: string;
  sourceAfter: string;
  statements: string[];
  metadata: string;
  phase: number;
}
export interface OracleTypeEvolutionRequest {
  target: OracleTypeManagementTarget;
  sourceBefore: string;
  sourceAfter: string;
  manifest?: OracleTypeEvolutionManifest;
}

export interface OracleTypeManagementPrivilege {
  grantee: string;
  privilege: string;
  grantable?: boolean | null;
  hierarchy?: boolean | null;
  grantor?: string | null;
  privilegeId?: string | null;
  privilegeType?: string | null;
  columnId?: string | null;
}

export interface OracleTypeManagementObject {
  owner: string;
  name: string;
  objectType: string;
  exists?: boolean | null;
  objectId?: string | null;
  status?: string | null;
  statusRead: TypeMetadataRead;
  triggerEnabled?: boolean | null;
  triggerEnabledRead?: TypeMetadataRead | null;
  source?: string | null;
  sourceRead: TypeMetadataRead;
  sourceFingerprint?: string | null;
  errors: OracleTypeManagementError[];
  errorsRead: TypeMetadataRead;
  directPrivileges: OracleTypeManagementPrivilege[];
  privilegesRead: TypeMetadataRead;
}

export interface OracleTypeManagementError {
  line: number;
  position: number;
  text: string;
}

export interface OracleTypeManagementDependency {
  owner: string;
  name: string;
  objectType: string;
  referencedOwner: string;
  referencedName: string;
  referencedType: string;
  referencedLink?: string | null;
}

export interface OracleTypeManagementReference {
  owner: string;
  tableName: string;
  columnName?: string | null;
  dataTypeOwner?: string | null;
  dataType?: string | null;
  tableStatus?: string | null;
  tableReadOnly?: boolean | null;
}

export interface OracleTypeManagementSnapshot {
  target: OracleTypeManagementTarget;
  visibilityScope: string;
  actingUser?: string | null;
  actingUserRead: TypeMetadataRead;
  details?: CustomTypeDetails | null;
  detailsRead: TypeMetadataRead;
  typeSource?: string | null;
  typeSourceRead: TypeMetadataRead;
  bodySource?: string | null;
  bodySourceRead: TypeMetadataRead;
  objects: OracleTypeManagementObject[];
  dependencies: OracleTypeManagementDependency[];
  dependenciesRead: TypeMetadataRead;
  persistentReferences: OracleTypeManagementReference[];
  persistentReferencesRead: TypeMetadataRead;
  directPrivileges: OracleTypeManagementPrivilege[];
  privilegesRead: TypeMetadataRead;
}

export type OracleTypeManagementSqlOperation = "save_spec" | "save_body" | "drop_spec" | "drop_body" | "grant_execute" | "grant_privilege" | "rebuild_source" | "compile_spec" | "compile_trigger";
export interface OracleTypeManagementSqlInput {
  databaseType: DatabaseType;
  operation: OracleTypeManagementSqlOperation;
  owner: string;
  name: string;
  source?: string | null;
  grantee?: string | null;
  grantable?: boolean;
  objectType?: ObjectSourceKind;
  privilege?: string;
  triggerEnabled?: boolean;
}
export interface OracleTypeManagementSqlResult {
  statements: string[];
  sourceFingerprint?: string | null;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  resolved_schema?: string;
  resolved_table?: string;
  resolved_object_type?: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  is_unique?: boolean;
  extra: string | null;
  comment?: string | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  character_maximum_length?: number | null;
  enum_values?: string[] | null;
  character_set?: string | null;
  collation?: string | null;
}

export interface SqlServerColumnMetadata extends ColumnInfo {
  is_identity: boolean;
  is_computed: boolean;
  is_hidden: boolean;
  generated_always_type: number;
}

export interface IndexInfo {
  /** Dictionary-derived index owner; absent in older or non-owner metadata. */
  owner?: string | null;
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  filter?: string | null;
  index_type?: string | null;
  included_columns?: string[] | null;
  comment?: string | null;
  /** Parallel to `columns`: true at index i means columns[i] is a raw expression, not a plain column name. */
  key_is_expression?: boolean[] | null;
  /** Parallel to `columns`: Oracle-family key ordering (`ASC` or `DESC`). */
  key_directions?: string[] | null;
  /** Oracle-family index visibility (`VISIBLE` or `INVISIBLE`). */
  visibility?: string | null;
  /** True only when expression, direction and visibility metadata are aligned and complete. */
  key_metadata_complete?: boolean;
  /** Parallel to `columns`: operator class name for each key column (PostgreSQL), if non-default. */
  column_opclasses?: (string | null)[] | null;
  /**
   * True when the index is the object behind a PRIMARY KEY / UNIQUE constraint rather than a
   * standalone index. Carried back to the backend inside the index draft's `original` snapshot:
   * Dameng only accepts `ALTER TABLE ... ADD/DROP CONSTRAINT` for those indexes.
   */
  constraint_backed?: boolean | null;
}

export interface ReferenceKeyInfo {
  columns: string[];
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  ref_schema?: string | null;
  ref_table: string;
  ref_column: string;
  on_update?: string | null;
  on_delete?: string | null;
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  level?: string | null;
  condition?: string | null;
  language?: string | null;
  enabled?: boolean | null;
  valid?: boolean | null;
  comment?: string | null;
  created_at?: string | null;
  statement?: string | null;
  oracle_metadata?: OracleTriggerMetadata | null;
}

/** Missing metadata means a provider has not established exact identity. */
export interface MetadataReadOptions {
  identityMode?: "exact";
  catalog?: string;
}

export interface OracleTriggerParent {
  owner: string;
  name: string;
  objectType: "TABLE" | "VIEW";
  objectId?: string | null;
}

export interface OracleTriggerReadState {
  state: "available" | "empty" | "denied" | "unavailable" | "unsupported" | "error" | "incomplete";
  message?: string | null;
}

export interface OracleTriggerMetadata {
  contractVersion: 1;
  identityMode: "exact";
  engine: "oracle" | "oceanbase-oracle" | "dm";
  engineVersion?: string | null;
  owner: string;
  name: string;
  scope: "TABLE" | "VIEW" | "SCHEMA" | "DATABASE" | "TIMER" | "OTHER" | "UNKNOWN";
  scopeType?: string | null;
  scopeOwner?: string | null;
  parent?: OracleTriggerParent | null;
  objectId?: string | null;
  lastDdlTime?: string | null;
  definition?: { origin: string; format: "ddl" | "declaration" | "body"; complete: boolean } | null;
  errors?: { sequence: number; line: number; position: number; text: string; severity?: string | null }[] | null;
  reads: Partial<Record<"identity" | "scope" | "parent" | "enabled" | "validity" | "definition" | "errors", OracleTriggerReadState>>;
}

export interface ConstraintInfo {
  name: string;
  constraint_type: string;
  definition: string;
  columns: string[];
  ref_schema?: string | null;
  ref_table?: string | null;
  ref_columns: string[];
  match_type?: string | null;
  on_update?: string | null;
  on_delete?: string | null;
  deferrable?: boolean | null;
  initially_deferred?: boolean | null;
  enabled?: boolean | null;
  valid?: boolean | null;
  oracle_metadata?: OracleConstraintMetadata | null;
}

export interface OracleConstraintMetadata {
  metadataComplete: boolean;
  owner: string;
  constraintType: string | null;
  status: string | null;
  validated: string | null;
  deferrable: string | null;
  deferred: string | null;
  rely: string | null;
  indexOwner: string | null;
  indexName: string | null;
  indexSharing: string | null;
  index: OracleConstraintIndexMetadata | null;
}

export interface OracleConstraintIndexMetadata {
  metadataComplete: boolean;
  owner: string;
  tableOwner: string;
  tableName: string;
  indexType: string;
  uniqueness: string;
  status: string;
  partitioned: boolean;
  visibility: string;
  secondary: string | null;
  columns: string[];
  directions: string[];
  keyIsExpression: boolean[];
  includedColumns: string[];
}

export interface PartitionInfo {
  name: string;
  position: number;
  value: string;
  partition_type: string;
  partition_key: string;
  online?: boolean | null;
  auto_partition_type?: string | null;
  auto_partition_span?: number | null;
}

export interface SubpartitionInfo {
  name: string;
  position: number;
  value: string;
  partition_type: string;
  partition_key: string;
}

export interface FunctionInfo {
  name: string;
  function_type: string;
  data_type: string;
  definition: string;
  arguments: string;
}

export interface SequenceInfo {
  name: string;
  data_type: string;
  start_value: string;
  min_value: string;
  max_value: string;
  increment: string;
  cycle: boolean;
  last_value?: string | null;
}

export interface RuleInfo {
  name: string;
  table_name: string;
  definition: string;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  comment?: string | null;
  schema?: string | null;
}

/** PostgreSQL event trigger metadata (`pg_event_trigger`). Database-level DDL trigger. */
export interface EventTriggerInfo {
  name: string;
  event: string;
  owner?: string | null;
  function?: string | null;
  enabled?: string | null;
  tags?: string[] | null;
  comment?: string | null;
  source?: string | null;
}

export interface OwnerInfo {
  object_name: string;
  object_type: string;
  owner: string;
}

/** A database server message carried on a query result (e.g. PostgreSQL RAISE NOTICE, MySQL warnings). */
export interface QueryMessage {
  severity: string;
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
}

export type QueryResultSourceLabelKind = "source" | "comment";

export interface QueryResult {
  columns: string[];
  /** Typed Neo4j node properties; source columns remain unchanged for paging. */
  neo4j_node_cells?: import("@/lib/neo4j/neo4jNodeResult").Neo4jNodeCell[];
  graph_data?: GraphResult;
  /** One SRID per geometry/geography column (first non-null observed). */
  spatial_columns?: SpatialColumn[];
  /**
   * Per-cell SRID metadata, parallel to `rows`: spatial_values[row][column] is
   * that cell's geometry SRID, or null for non-spatial cells / unknown SRIDs.
   * Every geometry value keeps its own SRID so mixed-SRID results stay correct.
   */
  spatial_values?: (number | null)[][];
  /** Internal marker for a result built by appending a page to existing rows. */
  appended_from_row_count?: number;
  /** Set for synthesized query execution failures. */
  execution_error?: true;
  /** Frontend execution that published this result; absent on older cached results. */
  sourceExecutionId?: string;
  /** Set only for SQL Server informational messages emitted by the backend. */
  server_message?: true;
  /** Manual-transaction UX marker for sticky proven-read-only dialects (Oracle,
   *  OceanBase-Oracle, MySQL, PostgreSQL): set on a manual-transaction result
   *  whose statement DBX proved to be an ordinary read by that dialect's strict
   *  heuristic. Absent for unproven statements and non-participating dialects. */
  manual_transaction_proven_read_only?: true;
  /** Manual-transaction UX marker for the same dialects: set on the synthetic
   *  successful result of an empty/whitespace/comments-only manual script. */
  manual_transaction_no_statement?: true;
  /** MySQL auto-commit tab session state reported by the backend for this
   *  execution: true = the tab connection still holds a transaction the user
   *  opened explicitly (`BEGIN` / `START TRANSACTION`) and DBX kept it open;
   *  false = the backend settled the connection and no such transaction is
   *  open. Absent when the execution never observed a tab-scoped MySQL
   *  connection, so the tab must keep its previous state. */
  auto_commit_open_transaction?: boolean;
  /** MySQL auto-commit tab: the backend rolled back a transaction the user
   *  opened explicitly and left open (the tab did not opt into keeping them). */
  auto_commit_explicit_transaction_rolled_back?: true;
  /** MySQL auto-commit tab: the backend rolled back a transaction the session
   *  opened implicitly because auto-commit was off (`SET autocommit = 0`).
   *  Nobody typed `BEGIN`, so the tab reports it separately — and only once per
   *  connection instead of after every execution. */
  auto_commit_session_autocommit_rolled_back?: true;
  /** Structured backend error; authoritative when execution_error is true. */
  error?: BackendError;
  /** Zero-based index of the submitted statement that produced this result. */
  statement_index?: number;
  /** Internal row identifiers appended to editable query results. */
  hidden_column_indexes?: number[];
  /** Local value filters survive DataGrid component eviction when switching tabs. */
  local_column_filters?: Record<string, string[]>;
  /** Manually hidden columns survive DataGrid component eviction when switching tabs. */
  local_hidden_column_keys?: string[];
  /**
   * Database type name for each column, parallel to `columns`. Optional and may
   * be shorter/empty when a driver cannot supply types (schemaless stores,
   * fallback query paths, older backends). Consumers must tolerate gaps.
   */
  column_types?: string[];
  /**
   * Sortable for each column. Parallel to `columns`. Optional and may
   * be shorter/empty when a driver cannot supply sortable information.
   */
  column_sortables?: boolean[];
  rows: (string | number | boolean | null)[][];
  /**
   * Original MongoDB documents, kept in lockstep with `rows` for document
   * preview. This is populated only for MongoDB document query results.
   */
  mongo_documents?: unknown[];
  /** Type-preserving Extended JSON documents used when copying MongoDB values. */
  mongo_copy_documents?: unknown[];
  affected_rows: number;
  execution_time_ms: number;
  /** OceanBase SQL Audit EXECUTE_TIME for a completed statement, in microseconds. */
  server_execute_time_us?: number;
  /** Desktop wait from query request dispatch to the complete result payload; summed across appended pages. Completed query/command requests only. */
  client_request_wait_ms?: number;
  /** Measured phases; totals overlap. Missing phases were not measured. */
  query_timings_ms?: Record<string, number>;
  client_prepare_ms?: number;
  client_result_ms?: number;
  timing_page_count?: number;
  /** Whether a backend-reported result total is exact. */
  total_is_exact?: boolean;
  truncated?: boolean;
  /** Variable-length cells represented by bounded previews in `rows`. */
  large_value_cells?: Array<{
    row_index: number;
    column_index: number;
    /** With value_ref, zero can mean an unknown byte size, not an empty value. */
    original_bytes: number;
    value_ref?: string;
    pending_decode?: boolean;
  }>;
  /** Authoritative original keys for internal reads; never derive these from interpreted display text. */
  raw_key_cells?: Array<{ row_index: number; column_index: number; value: string | number | boolean | null }>;
  /** Frontend-only original result connection, independent of the currently active tab. */
  large_value_context?: { connectionId: string; database: string; clientSessionId?: string; txnSessionId?: string; catalog?: string };
  /** Retained result refs also cover cells already hydrated into complete local values. */
  large_value_refs?: string[];
  /** Frontend-only dispatch identity; absent on results without captured provenance. */
  legacy_export_source?: {
    connectionId: string;
    database: string;
    schema?: string;
    catalog?: string;
    databaseType?: DatabaseType;
    connectionFingerprint: string;
    identifierQuote?: string;
    serverVersion?: string;
    statementSql?: string;
    hiddenPrimaryKeys?: Array<{ sourceName: string; alias: string }>;
    ordinaryReadSafe: boolean;
  };
  session_id?: string | null;
  /** Frontend-only owner of a manual transaction's result cursor, including retained runs. */
  manual_transaction_session_id?: string;
  has_more?: boolean;
  /** Frontend-only SQL page lookahead, independent of the driver's cursor has_more. */
  page_has_more?: boolean;
  /** Frontend-only page state, owned by the result rather than the active tab. */
  sqlPage?: {
    sql: string;
    executedSql: string;
    limit: number;
    offset: number;
    executedLimit: number;
    executedOffset: number;
    probe: boolean;
    countSql?: string;
    exactQueryRowBound?: number;
  };
  /** For Elasticsearch REST search results parsed into a _source table,
   *  this carries the raw HTTP response body so the UI can toggle between
   *  the tabular view and the original JSON. */
  elasticsearch_raw_body?: string;
  /** Preformatted Redis command output retained alongside the default grid rows. */
  redis_console_output?: string;
  sourceLabel?: string;
  /** Identifies whether sourceLabel came from a parsed object source or a SQL preamble comment. */
  sourceLabelKind?: QueryResultSourceLabelKind;
  /** 结果集来源的库名 / schema（与 sourceLabel 同时写入），供结果集页签按设置决定是否展示。 */
  sourceQualifier?: string;
  /** 结果集来源的对象名（通常为表名），关闭“结果集名称包含数据库名”时用于展示短名称。 */
  sourceName?: string;
  sourceStatement?: string;
  /** Absolute offsets in the editor document at execution time. */
  sourceFrom?: number;
  sourceTo?: number;
  /**
   * Frontend-internal: the statement text actually sent for this result when it
   * differs from `sourceStatement` (pagination wrapping, hidden-key rewrites…).
   * Backend SQL error positions are relative to this text, so it is needed to
   * map an error row/column back onto the user's original statement.
   */
  executedStatement?: string;
  /** Database server messages (notices, warnings) emitted while producing this result. Omitted when empty. */
  messages?: QueryMessage[];
}

export type BatchStatementExecutionStatus = "pending" | "running" | "success" | "error" | "skipped" | "cancelled";

export interface BatchStatementExecutionItem {
  statementIndex: number;
  sql: string;
  from: number;
  to: number;
  status: BatchStatementExecutionStatus;
  executionTimeMs?: number;
  affectedRows?: number;
  error?: string;
  errorDetails?: BackendError;
}

export interface BatchSqlExecution {
  executionId: string;
  submittedSql: string;
  editorFingerprint: string;
  sourceOffset: number;
  completed: number;
  total: number;
  startedAt: number;
  executionTarget?: MultiDbExecutionTarget;
  finishedAt?: number;
  recoveryDismissed?: boolean;
  items: BatchStatementExecutionItem[];
}

export interface SpatialColumn {
  column_index: number;
  srid: number | null;
}

export interface QueryResultSourceColumnRef {
  sourceKey: string;
  sourceColumn: string;
  /** Physical source identity for display-only features such as column formatters. */
  database?: string;
  schema?: string;
  tableName?: string;
}

export interface QueryResultRun {
  id: string;
  /** Source connection retained when the editor switches to another connection. */
  connectionId?: string;
  title: string;
  sequence: number;
  sql: string;
  createdAt: number;
  /** Keeps this result from being replaced by an ordinary query execution. */
  pinned?: boolean;
  /**
   * 标题是否由用户/多库执行显式指定（重命名或按目标库命名）。
   * 为假时 title 只是系统默认的 `Run N`，结果标签应改用来源名显示。
   */
  customTitle?: boolean;
  /** Distinguishes successive result payloads that reuse the same run slot. */
  resultGridRevision?: string;
  /**
   * 结果来源（库名.表名 / 表名），随批次一起保存。
   * 非活动批次的结果 payload 会被回收，因此结果标签命名不能依赖 payload。
   */
  sourceLabel?: string;
  sourceName?: string;
  /** Identifies whether sourceLabel came from a parsed object source or a SQL preamble comment. */
  sourceLabelKind?: QueryResultSourceLabelKind;
  /**
   * Logical-result identity for the tab-switch view snapshot cache. Distinct
   * from `resultGridRevision` (the grid remount key): this one changes on every
   * dataset replacement, including in-place refresh, and is preserved across
   * disk eviction/restore. See `dataGridViewStateCache.ts`.
   */
  resultViewGeneration?: string;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  batchSqlExecution?: BatchSqlExecution;
  resultBaseSql?: string;
  /** Fingerprint of the complete editor document when this result run started. */
  resultEditorFingerprint?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  resultSortMode?: "database" | "local";
  resultLocalSortOriginalRows?: QueryResult["rows"];
  resultLocalSortOriginalLargeValueCells?: QueryResult["large_value_cells"];
  resultLocalSortOriginalRawKeyCells?: QueryResult["raw_key_cells"];
  resultLocalSortOriginalMongoDocuments?: QueryResult["mongo_documents"];
  resultLocalSortOriginalMongoCopyDocuments?: QueryResult["mongo_copy_documents"];
  orderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultExecutedPageLimit?: number;
  resultExecutedPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultClientSessionId?: string;
  resultAccessedAt?: number;
  resultEstimatedBytes?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  resultEvicted?: boolean;
  queryAnalysis?: QueryTab["queryAnalysis"];
  querySourceColumns?: QueryTab["querySourceColumns"];
  queryWriteTargets?: QueryTab["queryWriteTargets"];
  resultColumnComments?: QueryTab["resultColumnComments"];
  resultColumnTypeLabels?: QueryTab["resultColumnTypeLabels"];
  queryDisplaySourceColumns?: QueryTab["queryDisplaySourceColumns"];
  queryEditabilityReason?: QueryTab["queryEditabilityReason"];
  mongoEditTarget?: QueryTab["mongoEditTarget"];
  tableMeta?: QueryTab["tableMeta"];
  multiDbExecution?: MultiDbResultRunExecution;
}

export interface ParticipantInfo {
  id: string;
  name: string;
  role: string;
}

export interface TransactionLog {
  transaction_id: string;
  status: string;
  participants: ParticipantInfo[];
  created_at: string;
  updated_at: string;
  metadata: unknown;
  /** camelCase fields from SchemaDiffDeployResult */
  transactionId?: string;
  executedCount?: number;
  statementCount?: number;
  error?: string;
}

/**
 * 1-based line and column range in SQL text.
 * Both `start_column` and `end_column` are 1-based and inclusive.
 * For example, a 1-character token at line 1, column 5 has:
 * `{ start_line: 1, start_column: 5, end_line: 1, end_column: 5 }`.
 */
export interface SqlTextSpan {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface SqlTableReference {
  name: string;
  database?: string | null;
  schema?: string | null;
  alias?: string | null;
  span: SqlTextSpan;
  scope_id?: number;
}

export interface SqlColumnReference {
  name: string;
  qualifier?: string | null;
  span: SqlTextSpan;
  scope_id?: number;
}

export interface SqlGroupByViolation {
  span: SqlTextSpan;
  column: string;
  qualifier?: string | null;
}

export interface SqlReferenceScope {
  id: number;
  parent_id?: number | null;
}

export interface SqlReferenceAnalysis {
  tables: SqlTableReference[];
  columns: SqlColumnReference[];
  scopes?: SqlReferenceScope[];
  group_by_violations?: SqlGroupByViolation[];
}

export type TreeNodeType =
  | "connection"
  | "connection-group"
  | "database"
  | "tablespace"
  | "datafile"
  | "doris-catalog"
  | "linked-server-root"
  | "linked-server"
  | "linked-server-catalog"
  | "linked-server-schema"
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "type"
  | "type-body"
  | "type-member"
  | "sequence"
  | "synonym"
  | "job"
  | "package"
  | "package-body"
  | "group-columns"
  | "group-indexes"
  | "group-database-indexes"
  | "group-fkeys"
  | "group-triggers"
  | "group-events"
  | "group-constraints"
  | "group-table-partitions"
  | "group-table-subpartitions"
  | "group-tables"
  | "table-vgroup"
  | "group-dolt-system-tables"
  | "group-views"
  | "group-materialized-views"
  | "group-procedures"
  | "group-functions"
  | "group-internal-functions"
  | "group-udf-functions"
  | "group-types"
  | "group-sequences"
  | "group-synonyms"
  | "oracle-db-links"
  | "oracle-db-link"
  | "group-jobs"
  | "group-packages"
  | "group-package-bodies"
  | "group-partitions"
  | "group-extensions"
  | "group-event-triggers"
  | "group-tablespaces"
  | "group-datafiles"
  | "extension"
  | "event-trigger"
  | "object-browser"
  | "user-admin"
  | "xugu-user-admin"
  | "dameng-users"
  | "dameng-roles"
  | "dameng-job-admin"
  | "database-job-admin"
  | "saved-sql-root"
  | "saved-sql-folder"
  | "saved-sql-file"
  | "table-search-control"
  | "load-more"
  | "column"
  | "type-attribute"
  | "type-method"
  | "type-attributes"
  | "type-methods"
  | "index"
  | "fkey"
  | "trigger"
  | "event"
  | "constraint"
  | "partition"
  | "subpartition"
  | "redis-db"
  | "mq-tenant"
  | "nacos-namespace"
  | "nacos-access-control"
  | "etcd-root"
  | "etcd-dashboard"
  | "etcd-access-control"
  | "zookeeper-root"
  | "consul-root"
  | "consul-overview"
  | "mongo-db"
  | "mongo-gridfs"
  | "mongo-buckets"
  | "mongo-bucket"
  | "mongo-collection"
  | "dynamodb-table"
  | "vector-database"
  | "vector-collection"
  | "elasticsearch-index"
  | "meilisearch-system"
  | "mqtt-topic";

export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export type SidebarOrderEntry = { type: "group"; id: string; children?: SidebarOrderEntry[]; connectionIds?: string[] } | { type: "connection"; id: string };

export interface SidebarLayout {
  groups: ConnectionGroup[];
  order: SidebarOrderEntry[];
}

export type TableVGroupOrderEntry = { type: "group"; id: string; children?: TableVGroupOrderEntry[] } | { type: "table"; name: string; /** 行类型（view/procedure/…）。同名双行容器（包 spec/body、type/type-body）靠它区分成员；缺省 = 按名字匹配（历史数据与表）。 */ rowType?: string };

export interface TableVGroupLayout {
  version?: number;
  groups: ConnectionGroup[];
  order: TableVGroupOrderEntry[];
  /** Toggled by the container context menu to hide groups without deleting them. */
  enabled?: boolean;
}

export interface TreeNode {
  id: string;
  label: string;
  type: TreeNodeType;
  /** Additional values matched by sidebar search without rendering them. */
  searchAliases?: string[];
  children?: TreeNode[];
  isLoading?: boolean;
  isExpanded?: boolean;
  pinned?: boolean;
  connectionId?: string;
  database?: string;
  /** Database-level compatibility mode, for example openGauss A/B/C/PG. */
  compatibilityMode?: string;
  catalog?: string;
  catalogType?: string;
  linkedServer?: string;
  linkedCatalog?: string;
  linkedSchema?: string;
  mqTenant?: string;
  mqInitialTab?: "topics";
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  schema?: string;
  tableName?: string;
  objectName?: string;
  /** Distinguishes schema indexes from the existing table-child index actions. */
  objectScope?: "schema";
  signature?: string;
  customTypeKind?: CustomTypeKind;
  hasMembers?: boolean;
  /** Owning programmable object for a nested metadata member. */
  parentName?: string;
  parentSchema?: string;
  parentType?: TreeNodeType;
  /** Set only for XuguDB object types whose members can be loaded lazily. */
  xuguTypeMembersExpandable?: boolean;
  /** Set on a Xugu package specification when a package body exists. */
  xuguPackageBodyAvailable?: boolean;
  /** Validity reported for the Xugu package body, independent of the spec. */
  xuguPackageBodyValid?: boolean | null;
  tableType?: string;
  comment?: string | null;
  valid?: boolean | null;
  sizeBytes?: number | null;
  xuguTablespace?: XuguTablespaceInfo;
  xuguDatafile?: XuguDatafileInfo;
  xuguDatafilePath?: string;
  objectCount?: number;
  loadedKeyCount?: number;
  totalKeyCount?: number;
  partitionParentSchema?: string;
  partitionParentName?: string;
  hiddenChildren?: TreeNode[];
  tableSearchParentId?: string;
  savedSqlId?: string;
  savedSqlFolderId?: string;
  /** Set on synthetic table virtual-group container nodes. */
  vgroupId?: string;
  /** 投影时盖章的分组类别（tables/views/…），供拖拽落点 O(1) 类别判定。 */
  vgroupKind?: string;
  meta?: ColumnInfo | IndexInfo | ForeignKeyInfo | TriggerInfo | ConstraintInfo | PartitionInfo | SubpartitionInfo | ExtensionInfo | EventTriggerInfo | VectorCollectionMeta | MongoCollectionMeta | CustomTypeTreeMemberMeta;
  loadMore?: {
    parentId: string;
    objectType?: "INDEX";
    offset: number;
    pageSize: number;
    /** Backend filter and global-search identity for OceanBase metadata pages. */
    searchFilter?: string;
    searchQuery?: string;
    /**
     * Identity of the row that was expected to open this page: the peek row the
     * previous page fetched but did not display. Offset paging is not snapshot
     * consistent, so when objects are created or dropped above the window the
     * same offset points at a different row; comparing against this anchor lets
     * the page notice that and re-read the window instead of leaving a gap.
     */
    anchor?: string;
  };
}

export interface CustomTypeTreeMemberMeta {
  kind: "field" | "enum-value";
  displayValue?: string;
  ordinal?: number;
}

export interface TableNameFilter {
  includePatterns: string[];
  excludePatterns: string[];
}

export type TableInfoTab = "info" | "columns" | "indexes" | "foreignKeys" | "constraints" | "triggers" | "partitions" | "ddl" | "relations";

/** PostgreSQL declarative partitioning strategy (`pg_partitioned_table.partstrat`). */
export type PgPartitionKind = "range" | "list" | "hash";

/** Structured form of a partition's `pg_get_expr(relpartbound)` definition. Values are the SQL literal text PostgreSQL reported (`'2024-01-01'`, `MINVALUE`, `0`). */
export type PgPartitionBound = { kind: "range"; from: string[]; to: string[] } | { kind: "list"; values: string[] } | { kind: "hash"; modulus: number; remainder: number } | { kind: "default" };

export interface PgPartitionNode {
  schema: string;
  name: string;
  strategy?: PgPartitionKind;
  keyDefinition?: string;
  bound?: PgPartitionBound;
  boundDefinition?: string;
  isLeaf: boolean;
  rowEstimate?: number;
  totalBytes?: number;
  children: PgPartitionNode[];
}

export interface PgTablePartitioning {
  isPartitioned: boolean;
  isPartition: boolean;
  parent?: string;
  parentSchema?: string;
  parentTable?: string;
  ownBound?: PgPartitionBound;
  strategy?: PgPartitionKind;
  keyDefinition?: string;
  keyColumns: string[];
  keyExpression?: string;
  defaultPartition?: string;
  partitions: PgPartitionNode[];
  /** `server_version_num`, used to gate `DETACH PARTITION CONCURRENTLY` (14+). */
  serverVersionNum?: number;
}

export interface TableStructureEditorTarget {
  kind: "column" | "index";
  name: string;
  /** Raw schema-index owner; omitted by legacy table-child navigation. */
  owner?: string;
  /** Schema-index requests are consumed once by the existing draft editor. */
  action?: "create" | "delete";
}

export interface SchemaIndexIdentity {
  schema: string;
  name: string;
  parentSchema: string;
  parentName: string;
}

export interface TableStructureEditorDraft {
  dirty?: boolean;
  activeTab: TableInfoTab;
  /** DDL as loaded from the database — the baseline `ddlDraft` is compared against. */
  ddlContent?: string;
  /** Original DDL and display preference retained so restoring a draft cannot change its baseline. */
  rawDdlContent?: string;
  excludeDdlStorage?: boolean;
  includeDdlStorage?: boolean;
  compactDdlSql?: boolean;
  separateDdlIndexes?: boolean;
  /** Edited DDL script, or null/undefined when the DDL tab was left untouched. */
  ddlDraft?: string | null;
  newTableName: string;
  tableComment: string;
  originalTableComment: string;
  mysqlAutoIncrementValue?: string;
  originalMysqlAutoIncrementValue?: string;
  mysqlTableEngine?: string;
  originalMysqlTableEngine?: string;
  mysqlTableCharset?: string;
  originalMysqlTableCharset?: string;
  mysqlTableCollation?: string;
  originalMysqlTableCollation?: string;
  physicalOptions?: import("@/lib/table/tablePhysicalOptions").TablePhysicalOptionsDraft;
  starrocksLayoutDraft?: import("@/lib/table/starrocksAlterOptions").StarRocksLayoutDraft;
  starrocksSortColumns?: string[];
  starrocksPhysicalOptions?: import("@/lib/table/starrocksPhysicalOptions").StarRocksPhysicalOptionsDraft;
  postgresForeignTable?: import("@/lib/table/postgresForeignTable").PostgresForeignTableDraft;
  tableOwner?: string;
  originalTableOwner?: string;
  columns: import("@/lib/table/tableStructureEditorSql").EditableStructureColumn[];
  indexes: import("@/lib/table/tableStructureEditorSql").EditableStructureIndex[];
  foreignKeys: import("@/lib/table/tableStructureEditorSql").EditableStructureForeignKey[];
  constraints?: ConstraintInfo[];
  existingPrimaryKey?: NonNullable<import("@/lib/table/tableStructureEditorSql").BuildTableStructureChangeSqlOptions["primaryKeyChange"]>;
  oracleConstraintChange?: import("@/lib/table/tableStructureEditorSql").OracleConstraintChange;
  oracleForeignKeyCreateRecovery?: {
    tableName: string;
    tableExists: boolean;
    details: string;
    remaining: import("@/lib/table/tableStructureEditorSql").OracleForeignKeyDefinition[];
    uncertainSteps: string[];
  };
  oracleTriggerStructureRecovery?: {
    target: import("@/lib/database/oracleTriggerStructurePlan").OracleTriggerStructureTarget;
    steps: import("@/lib/database/oracleTriggerPlan").OracleTriggerStructureStepResult[];
    details: string;
  };
  constraintsLoaded?: boolean;
  triggers: import("@/lib/table/tableStructureEditorSql").EditableStructureTrigger[];
  triggersLoaded?: boolean;
  /** Pending PostgreSQL partition operations (create/attach/detach/drop). */
  partitionOperations?: import("@/lib/table/tableStructureEditorSql").TablePartitionOperation[];
  /** Create-mode `PARTITION BY` declaration. */
  createPartitioningEnabled?: boolean;
  createPartitioningKind?: import("@/types/database").PgPartitionKind;
  createPartitioningColumns?: string[];
  createPartitioningExpression?: string;
  loadedMetadataFacets?: import("@/lib/metadata/objectMetadataCache").ObjectMetadataFacet[];
  scrollPositions?: Partial<Record<TableInfoTab, TableStructureEditorViewport>>;
  /** Request id of the structureInitialTab the editor already applied; remounts must not replay a consumed initial tab over the restored draft. */
  appliedInitialTabRequestId?: number;
  appliedInitialTargetRequestId?: number;
  oracleIndexRecovery?: {
    target: string;
    completedCreates: import("@/lib/database/oracleIndexes").OracleIndexDefinition[];
    refreshError?: string;
  };
  initialized: boolean;
}

export interface TableStructureEditorViewport {
  scrollTop: number;
  scrollLeft: number;
}

export type ObjectBrowserViewMode = "list" | "grid" | "compact";

export type ObjectBrowserFilter = "all" | "tables" | "views" | "materializedViews" | "procedures" | "functions" | "triggers" | "events" | "sequences" | "indexes" | "packages" | "types";

export interface ObjectBrowserViewport {
  scrollTop: number;
  viewMode: ObjectBrowserViewMode;
}

/** Runtime-only viewport state for the selected configuration in a Nacos tab. */
export interface NacosConfigEditorViewport {
  namespace: string;
  dataId: string;
  group: string;
  scrollTop: number;
  scrollLeft: number;
}

export interface ExternalSqlFileVersion {
  sizeBytes: number;
  modifiedNs: string;
  contentHash: string;
}

export interface QueryPageJumpProgress {
  completedRequests: number;
  totalRequests: number;
  targetPage: number;
}

export type TabOutputView = "result" | "graph" | "summary" | "explain" | "chart" | "messages" | "profile";

export type RedisResultViewMode = "grid" | "console";

export type TabPageUiState = Record<string, unknown>;

/** UI-only state that must survive an inactive tab's component being unmounted. */
export interface TabUiState {
  activeOutputView?: TabOutputView;
  /** Redis query results default to grid; a per-tab override selects command-line output. */
  redisResultViewMode?: RedisResultViewMode;
  resultPaneOpen?: boolean;
  /** Tracks whether the active output view was auto-switched to "messages" by live server output during execution. */
  autoSwitchedToMessagesDuringExecution?: boolean;
  /**
   * Execution id whose batch run already auto-switched the output view to the
   * summary. Keying the switch by run keeps it to once per execution, so a user
   * who picks another view mid-run stays there.
   */
  batchSummaryExecutionId?: string;
  /** Small JSON-compatible snapshots owned by special-page components. */
  page?: Record<string, TabPageUiState>;
}

export type DatabaseSearchScope = "data" | "structure";

export interface DatabaseSearchResultItem {
  id: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  matchedColumns: string[];
  preview: string;
  whereInput: string;
  /** Present for structure-scope hits (column name / comment search). */
  searchScope?: DatabaseSearchScope;
  columnName?: string;
  columnComment?: string;
  structureMatchIn?: Array<"name" | "comment" | "tableComment">;
}

export interface DatabaseSearchTableTask {
  schema?: string;
  table: TableInfo;
}

export interface DatabaseSearchTabState {
  keyword: string;
  searchScope?: DatabaseSearchScope;
  perTableLimit: number;
  progressDone: number;
  progressTotal: number;
  results: DatabaseSearchResultItem[];
  tableErrors: Array<{ tableName: string; message: string }>;
  generalError: string;
  tableTasks: DatabaseSearchTableTask[];
  nextTableIndex: number;
  activeKeyword: string;
  activePerTableLimit: number;
}

export interface QueryTab {
  isDefaultQuery?: boolean;
  id: string;
  /** Stable creation time used when tabs are displayed in creation order. */
  createdAt?: number;
  title: string;
  customTitle?: boolean;
  /**
   * 同名标签之间用来区分的稳定编号，以及分配编号时的那个显示标题。
   *
   * 编号只在标签首次出现重名时分配一次，之后即使其它重名标签被关闭也不再回收到
   * 其它标签上：关闭中间的标签不会让后面的标签改名（#9938）。因为标签的显示标题
   * 会随库名切换、重命名、紧凑标题设置而变，所以用 titleNumberKey 记住分配时的
   * 标题，标题变了就重新参与分配。
   */
  titleNumber?: number;
  titleNumberKey?: string;
  /**
   * User-chosen suffix shown after the tab title (set from the tab context menu).
   * It replaces the automatic `titleNumber` for this tab and is persisted with it.
   */
  titleSuffix?: string;
  /** Force the editor to word-wrap regardless of the global setting, e.g. for auto-generated single-line templates. */
  forceWordWrap?: boolean;
  connectionId: string;
  database: string;
  /**
   * 所属连接被删除后，被保留下来的 SQL 页签会记录原连接名。新建同名连接时按此
   * 字段把页签重新绑定到新连接上；绑定完成后清空。
   */
  detachedConnectionName?: string;
  /** Optional branch context for a driver-profile database workspace. */
  workspaceBranch?: string;
  schema?: string;
  /**
   * 该 Schema 是否由用户为当前页签显式选择（工具栏 / 侧栏 Schema 节点）。
   *
   * SQL Server 没有会话级 Schema 切换，后端会把未限定的表名按页签 Schema
   * 改写（#8951）。只有显式选择才能参与改写：连接默认 Schema、恢复的页签、
   * 保存的 SQL、外部文件带来的 Schema 只用于浏览/补全/预填，否则
   * `SELECT * FROM t` 会被错误地限定到非默认 Schema。
   *
   * 该字段是运行时状态，不随页签持久化，恢复的页签因此回到服务器默认解析。
   */
  schemaQualifiesSql?: boolean;
  /** Doris / StarRocks multi-catalog: the external catalog this tab's
   * database belongs to (undefined for internal/default catalog). */
  catalog?: string;
  sql: string;
  savedSqlId?: string;
  externalSqlPath?: string;
  externalSqlEncoding?: "auto" | "utf8" | "utf8Bom" | "utf16le" | "utf16be" | "gbk";
  externalSqlFileVersion?: ExternalSqlFileVersion;
  externalSqlIgnoredFileVersion?: ExternalSqlFileVersion;
  externalSqlFileMissing?: boolean;
  originalSql?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  /** Fingerprint of the complete editor document when the displayed result started. */
  resultEditorFingerprint?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  resultSortMode?: "database" | "local";
  resultLocalSortOriginalRows?: QueryResult["rows"];
  resultLocalSortOriginalLargeValueCells?: QueryResult["large_value_cells"];
  resultLocalSortOriginalRawKeyCells?: QueryResult["raw_key_cells"];
  resultLocalSortOriginalMongoDocuments?: QueryResult["mongo_documents"];
  resultLocalSortOriginalMongoCopyDocuments?: QueryResult["mongo_copy_documents"];
  orderByInput?: string;
  /**
   * Structured (sort builder) ORDER BY applied on top of `orderByInput`. Kept as
   * a sibling field so the manual input stays editable while store-side SQL
   * rebuilds (refresh/export/restore) still reproduce the composite sort.
   */
  structuredOrderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  /**
   * Pagination of the execution that actually produced (or extended) the
   * displayed result. `resultPageLimit`/`resultPageOffset` deliberately stay on
   * the logical first page so a later refresh never re-runs only the appended
   * tail segment; this pair mirrors the segment that ran instead, which the grid
   * needs to show the SQL behind the current rows after "load all".
   */
  resultExecutedPageLimit?: number;
  resultExecutedPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultClientSessionId?: string;
  /** Ephemeral UI progress for sequential Elasticsearch cursor requests. */
  resultPageJumpProgress?: QueryPageJumpProgress;
  resultAccessedAt?: number;
  resultEstimatedBytes?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  pinned?: boolean;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  /** Distinguishes successive result payloads that reuse the current result slot. */
  resultGridRevision?: string;
  /** Logical-result identity for the tab-switch view snapshot cache; see QueryResultRun. */
  resultViewGeneration?: string;
  resultRuns?: QueryResultRun[];
  activeResultRunId?: string;
  /** Undefined inherits the default on open; false preserves an explicit per-tab opt-out. */
  resultAutoSave?: boolean;
  uiState?: TabUiState;
  explainPlan?: import("@/lib/diagram/explainPlan").ParsedExplainPlan;
  /** MySQL's regular EXPLAIN result, kept alongside its JSON visual plan. */
  explainTableResult?: QueryResult;
  explainError?: string;
  explainTableError?: string;
  explainSql?: string;
  explainTableSql?: string;
  lastExplainedSql?: string;
  isExecuting: boolean;
  redisMonitorActive?: boolean;
  isCancelling?: boolean;
  queryExecutionStartedAt?: number;
  /** Ephemeral per-statement progress for the latest multi-statement execution. */
  batchSqlExecution?: BatchSqlExecution;
  editorViewport?: {
    scrollTop: number;
    scrollLeft: number;
  };
  editorSelection?: {
    anchor: number;
    head: number;
  };
  /** Ephemeral request to move the cursor/scrolling to a specific line/column (e.g. global content search jump). */
  editorRevealRequest?: {
    id: number;
    line: number;
    column?: number;
  };
  /** Ephemeral request to reveal/scroll to a specific column in the data grid. */
  gridRevealColumnRequest?: {
    id: number;
    columnName: string;
  };
  executionId?: string;
  liveQueryMessages?: QueryMessage[];
  /** Ephemeral result run targeted by the current execution; null means a new run is being produced. */
  executingResultRunId?: string | null;
  isExplaining?: boolean;
  explainExecutionId?: string;
  /** Per-run connection session for explain flows that require session state. */
  explainClientSessionId?: string;
  /** Invalidates tab-scoped completion metadata after session context changes. */
  completionContextVersion?: number;
  mode:
    | "data"
    | "query"
    | "redis"
    | "redis-dashboard"
    | "mongo"
    | "meilisearch"
    | "meilisearch-system"
    | "mongo-gridfs"
    | "mongo-bucket"
    | "vector"
    | "hbase"
    | "etcd"
    | "etcd-dashboard"
    | "etcd-access-control"
    | "zookeeper"
    | "consul"
    | "consul-overview"
    | "mq"
    | "mqtt"
    | "nacos"
    | "nacos-dashboard"
    | "nacos-access-control"
    | "databases"
    | "objects"
    | "structure"
    | "users"
    | "xugu-users"
    | "dameng-users"
    | "dameng-roles"
    | "dameng-jobs"
    | "database-jobs"
    | "processlist"
    | "sqlserver-trace"
    | "pl-debug"
    | "mysql-dashboard"
    | "postgres-dashboard"
    | "xugu-dashboard"
    | "solr-admin"
    | "dolt-version-control"
    | "plugin-workbench"
    | "plugin-filesystem"
    | "database-search";
  pluginWorkbench?: {
    /** Host command that created this tab; distinct commands can share a workbench. */
    commandId?: string;
    pluginId: string;
    contributionId: string;
    defaultTitle?: string;
    context?: Record<string, unknown>;
  };
  pluginFilesystem?: {
    pluginId: string;
    providerId: string;
    rootUri?: string;
    currentUri?: string;
  };
  /** Ephemeral navigation intent; it is consumed by HBaseBrowser and is not persisted. */
  hbaseCreateTableOnOpen?: boolean;
  /** Connection-level native Job selection; bodies and backend context IDs are not persisted. */
  nativeJobAdmin?: { kind: "scheduler"; owner: string; name: string } | { kind: "legacy"; jobId: string } | { kind: "dameng-native"; jobId: string; name: string };
  mqTenant?: string;
  mqInitialTab?: "topics";
  mqttInitialTopic?: string;
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  nacosTargetDataId?: string;
  nacosTargetGroup?: string;
  nacosTargetKeyword?: string;
  nacosTargetRequestId?: number;
  nacosConfigEditorViewport?: NacosConfigEditorViewport;
  structureTableName?: string;
  structureExactIdentity?: boolean;
  /** Navigation type of the opened structure object; views matter for "view data" routing. */
  structureTableType?: "table" | "view";
  structureInitialTab?: TableInfoTab;
  structureInitialTabRequestId?: number;
  structureInitialTarget?: TableStructureEditorTarget;
  /** Runtime-only request to locate an object in the existing read-only properties. */
  objectPropertiesRequest?: {
    requestId: string;
    connectionId: string;
    database: string;
    schema: string;
    catalog?: string;
    name: string;
    objectType: "TABLE" | "VIEW" | "MATERIALIZED_VIEW";
    initialTab: TableInfoTab;
    focusObject?: { owner: string; name: string; type: "INDEX" };
  };
  structureDraft?: TableStructureEditorDraft;
  databaseSearchState?: DatabaseSearchTabState;
  objectBrowser?: {
    catalog?: string;
    schema?: string;
    objectType?: "tables";
    eventName?: string;
    eventReadOnly?: boolean;
    eventOpenRequestId?: number;
    /** 显式的"新建事件"请求：单调递增，用于让已复用 tab 也能重复进入 CREATE 编辑器 */
    eventCreateRequestId?: number;
    initialObjectFilter?: "tables" | "events" | "indexes";
    indexRequestSequence?: number;
    indexCreateRequestId?: number;
    initialViewTarget?: SchemaIndexIdentity;
    initialViewRequestId?: number;
    filter?: ObjectBrowserFilter;
    searchQuery?: string;
    viewport?: ObjectBrowserViewport;
  };
  /** Opened to view object source, including objects without editable source metadata. */
  sourceView?: boolean;
  /** Stable object identity and local section, independent of pending source loading. */
  objectDetails?: {
    connectionId: string;
    database: string;
    schema: string;
    catalog?: string;
    name: string;
    objectType: ObjectSourceKind;
    section: "source" | "dependencies" | "dependents" | "foreignKeys" | "ownership";
  };
  ddlViewer?: {
    schema?: string;
    explicitOwner?: string;
    tableName: string;
    objectType?: ObjectSourceKind;
    formatDialect?: SqlFormatDialect;
    displaySource?: string;
    separateIndexes?: boolean;
  };
  /**
   * 「先出 tab 再加载」的中间态：DDL 新标签已经可见，但 DDL 还在路上
   * （issue #9387）。让 tab 栏与编辑区在等待期间就有反馈，失败时就地显示
   * 错误 + Retry，而不是加载完成后才建 tab、失败只弹 toast。
   *
   * 纯运行期字段，刻意不进 openTabsPersistence 的落盘白名单：重启后恢复出的
   * tab 直接使用落盘的 SQL 文本，不会永久停在「加载中」。
   */
  ddlLoad?: {
    startedAt: number;
    /** 加载失败时写入；保留状态以便就地重试 */
    error?: string;
  };
  objectSource?: {
    schema?: string;
    name: string;
    objectType: ObjectSourceKind;
    signature?: string;
  };
  /** Durable TYPE definitions and step records; restored plans require fresh verification. */
  typeManagementDraft?: import("@/lib/table/oracleTypeManagement").OracleTypeManagementDraft;
  /** Explicit edit mode; TYPE source opens read-only and restores read-only. */
  typeSourceEditing?: boolean;
  /**
   * 「先出 UI 再加载」的中间态：源码 tab 已经可见，但源码还在路上
   * （ensureConnected + getObjectSource）。让 tab 栏与编辑区在等待期间就有反馈，
   * 失败时就地显示错误 + Retry，而不是等到加载完才建 tab、失败只弹 toast。
   *
   * 纯运行期字段，刻意不进 openTabsPersistence 的落盘白名单：重启后恢复出的
   * tab 只是普通空 tab，不会永久停在「加载中」。
   */
  sourceLoad?: {
    startedAt: number;
    /** Whether this request should open an editable object definition instead of the original source. */
    initialEditing?: boolean;
    /** 加载失败时写入；保留 request 以便就地重试 */
    error?: string;
    /**
     * 重试所需的请求身份。与 `objectSource` 分开保存：objectType 在这里是
     * **请求时**的类型，而 `objectSource.objectType` 是 routine fallback
     * 解析后的类型（PROCEDURE↔FUNCTION、PACKAGE↔PACKAGE_BODY 会被改写）。
     */
    request: {
      name: string;
      objectType: ObjectSourceKind;
      signature?: string;
    };
  };
  tableComment?: string | null;
  tableMeta?: {
    schema?: string;
    tableName: string;
    tableType?: string;
    catalog?: string;
    database?: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
    /** User-declared row identifier columns, used only when no automatic stable identifier exists. */
    virtualPrimaryKeys?: string[];
    /** Physical primary keys used for table-open default sorting; excludes unique and synthetic row identifiers. */
    physicalPrimaryKeys?: string[];
  };
  tableMetaUpdatedAt?: number;
  /** 该 tab 的 tableMeta 是哪个连接元数据代次下写入的：disconnect / 关闭数据库 /
   * 死池重连等生命周期边界会让该代次递增，代次失配视同冷缓存（issue #6623 / PR #6640）。 */
  tableMetaGeneration?: number;
  pendingDataChangeCount?: number;
  /** Ephemeral editor draft that has not yet been applied to the data grid. */
  hasPendingDataEditorDraft?: boolean;
  /** 冷缓存打开表数据时元数据仍在途：行标识未知，编辑/保存必须等待其落地 */
  tableMetaPending?: boolean;
  /** 取消请求单调计数：isCancelling 是瞬态的（取消失败/查询先完成会被清），
   * 需要跨越 executeTabSql 生命周期判断"执行期间用户是否请求过停止"时比对它 */
  cancelRequestCount?: number;
  tableInfoTab?: TableInfoTab;
  queryAnalysis?: {
    catalog?: string;
    catalogQuoted?: boolean;
    schema?: string;
    schemaQuoted?: boolean;
    tableName: string;
    tableNameQuoted?: boolean;
    tableAlias?: string;
    selectStar: boolean;
    editableSourceKey?: string;
    multiSource?: boolean;
    allowInsert?: boolean;
    allowDelete?: boolean;
    allowInsertDelete?: boolean;
    distinct?: boolean;
    sources?: {
      key: string;
      catalog?: string;
      catalogQuoted?: boolean;
      schema?: string;
      schemaQuoted?: boolean;
      tableName: string;
      tableNameQuoted?: boolean;
      alias?: string;
    }[];
    columns: {
      sourceName?: string;
      sourceNameQuoted?: boolean;
      sourceQualifier?: string;
      sourceKey?: string;
      star?: boolean;
      resultName: string;
      expression: string;
    }[];
    groupByColumns?: {
      sourceName?: string;
      sourceNameQuoted?: boolean;
      sourceQualifier?: string;
      sourceKey?: string;
      star?: boolean;
      resultName: string;
      expression: string;
    }[];
  };
  querySourceColumns?: Array<string | undefined>;
  queryWriteTargets?: Array<{ tableMeta: NonNullable<QueryTab["tableMeta"]>; sourceColumns: Array<string | undefined> }>;
  /**
   * Column comments for a multi-source query result (e.g. JOIN), indexed by
   * result-column ordinal (projection order). Each entry is the comment of the
   * single base column that result column resolves to; `undefined` when the
   * column is ambiguous (e.g. an unqualified name present in several sources)
   * or cannot be resolved back to a base column, so the grid shows no comment
   * instead of a wrong one. Populated even when the result is not editable
   * (e.g. multi-table JOIN), so joined results still show column comments.
   */
  resultColumnComments?: Array<string | undefined>;
  /**
   * Display-only column type labels for multi-source (or otherwise enriched)
   * query results, indexed by result-column ordinal. Built from resolved base
   * column metadata so headers can show declared length/precision (e.g.
   * `varchar(50)`) even when ResultSet `column_types` only carry bare type
   * names. `undefined` entries fall back to ResultSet / single-table metadata.
   */
  resultColumnTypeLabels?: Array<string | undefined>;
  /**
   * Display-only result-column to source mapping for multi-source results,
   * indexed by result-column ordinal. Each entry carries the source identity
   * (sourceKey + canonical source column name), so comments resolve per source
   * instead of first-source-wins on name clashes. Unlike querySourceColumns it
   * is also populated for multi-source results that are not editable, and must
   * never be used for row identity or editing.
   */
  queryDisplaySourceColumns?: Array<QueryResultSourceColumnRef | undefined>;
  queryEditabilityReason?: "not-select" | "cte" | "set-operation" | "aggregation" | "external-source" | "complex-source" | "computed-columns" | "no-table" | "no-primary-key" | "primary-key-not-returned" | "aliased-columns" | "metadata-unavailable";
  mongoEditTarget?: {
    collection: string;
    idColumn: "_id";
  };
  /**
   * MongoDB query tabs only. "sql" compiles the editor text to a mongo-shell
   * command before the existing execution path runs it. Absent means shell.
   */
  mongoQueryLanguage?: "shell" | "sql";
  /** Shell text produced by the latest SQL-mode execution. Not persisted. */
  mongoGeneratedShell?: string;
  mongoBucket?: {
    bucketName: string;
  };
  resultEvicted?: boolean;
  whereInput?: string;
  previewSql?: string;
  /** Whether to use auto-commit mode (default true). When false, multiple statements are
   *  wrapped in a single transaction. */
  autoCommit?: boolean;
  /** Session ID for an active manual transaction, set after beginManualTransaction */
  txnSessionId?: string;
  /** Runtime-only SQL Server transaction lifecycle and last terminal notice. */
  txnStatus?: "opening" | "active" | "executing" | "ending" | "lost" | "unknown";
  txnNotice?: string;
  txnIndependentConnectionExplained?: boolean;
  /** Set to true when a manual transaction was auto-rolled back due to inactivity */
  txnAutoRolledBack?: boolean;
  /** Sticky proven-read-only dialects (Oracle/OceanBase-Oracle/MySQL/PostgreSQL),
   *  not persisted: whether the current manual session has executed at least one
   *  statement DBX cannot prove read-only. Commit/Rollback actions are hidden
   *  while a session is clean. Never cleared by a later read. */
  txnPossiblyDirty?: boolean;
  /** Auto-commit tabs (`Tx:A`) with a MySQL-family connection: whether the tab's
   *  connection currently holds a transaction the user opened explicitly
   *  (`BEGIN` / `START TRANSACTION`). The backend reports it on every execution
   *  that observed the connection; the tab mirrors it into the `Tx` badge and
   *  the commit/rollback actions. Not persisted. */
  autoCommitOpenTransaction?: boolean;
  /** Auto-commit tab: show the notice that the backend rolled back an explicit
   *  transaction this tab left open, so the cleanup is never silent. */
  autoCommitTxnRolledBack?: boolean;
  /** Same cleanup, but the rolled-back transaction came from a session with
   *  auto-commit turned off (`SET autocommit = 0`) rather than from a `BEGIN`
   *  the user typed. Shown with its own wording so the notice is not mistaken
   *  for a lost explicit transaction. */
  autoCommitSessionTxnRolledBack?: boolean;
  /** Dedupe marker for {@link autoCommitSessionTxnRolledBack}: an
   *  auto-commit-off session rolls back an implicit transaction after *every*
   *  execution, so the notice is raised once and re-armed only after the
   *  connection stops reporting that rollback. */
  autoCommitSessionTxnRolledBackNotified?: boolean;
}

export interface SavedSqlFolder {
  id: string;
  connectionId: string;
  parentFolderId?: string;
  name: string;
  orderIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSqlFile {
  /** The persistent, autosaved query for this connection/catalog/database. */
  isDefaultQuery?: boolean;
  id: string;
  connectionId: string;
  folderId?: string;
  name: string;
  database: string;
  /** Undefined means the connection's built-in/default catalog. */
  catalog?: string;
  schema?: string;
  sql: string;
  sqlLoaded?: boolean;
  orderIndex?: number;
  openCount?: number;
  openedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSqlLibrary {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}

/** Serializable configuration of a saved data-transfer task. */
export type TransferPackageDraft = Pick<OracleRoutinePlanDraft, "identity" | "sourceName" | "sql" | "packageBodySource" | "packageContract" | "confirmPackagePair"> & { reviewedTargetDraft?: boolean };

export interface TransferTaskConfig {
  sourceConnectionId: string;
  /** Undefined means the connection's built-in/default catalog. */
  sourceCatalog?: string;
  sourceDatabase: string;
  sourceSchema?: string;
  targetConnectionId: string;
  targetCatalog?: string;
  targetDatabase: string;
  targetSchema?: string;
  /** Selected object names grouped by object kind (TABLE, VIEW, ...). */
  objects: Partial<Record<TransferObjectKind, string[]>>;
  oraclePackageDrafts?: TransferPackageDraft[];
  content: TransferContent;
  mode: TransferMode;
  targetTableNameCase: TransferTableNameCase;
  targetColumnNameCase?: TransferColumnNameCase;
  quoteTargetColumnNames: boolean;
  batchSize: number;
  /** Per-operation timeout for this task. Undefined inherits each connection; 0 disables the limit. */
  operationTimeoutSecs?: number;
  /** Optional per-source-table transfer filter (bare WHERE or a full SELECT). */
  tableFilters?: Record<string, string>;
  /** Legacy-compatible rebuild flag; true takes precedence over the saved DML mode. */
  dropTargetBeforeCreate?: boolean;
  /** Legacy field only. Saved confirmation is always ignored and reset to false. */
  dropTargetConfirmed?: boolean;
}

export interface TransferTask {
  id: string;
  folderId?: string;
  name: string;
  orderIndex?: number;
  config: TransferTaskConfig;
  createdAt: string;
  updatedAt: string;
}

export interface TransferTaskFolder {
  id: string;
  parentFolderId?: string;
  name: string;
  orderIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransferTaskLibrary {
  version: 1;
  folders: TransferTaskFolder[];
  tasks: TransferTask[];
}

export interface VectorCollectionMeta {
  dimension?: number;
  collectionId?: string;
}

export interface MilvusFieldInfo {
  name: string;
  dataType: string;
  dimension?: number;
  primaryKey: boolean;
  autoId: boolean;
  nullable: boolean;
  hasDefaultValue: boolean;
  isFunctionOutput: boolean;
}

export interface MilvusCollectionSchema {
  fields: MilvusFieldInfo[];
}

/** Mongo collection node metadata (not SQL tableType). */
export type MongoCollectionKind = "collection" | "view" | "timeseries";

export interface MongoCollectionMeta {
  collectionKind: MongoCollectionKind;
}

export interface CollectionInfo {
  name: string;
  id: string;
  dimension?: number;
  milvusSchema?: MilvusCollectionSchema;
  kind?: MongoCollectionKind | "bucket";
  bucketName?: string;
  aliases?: string[];
}
