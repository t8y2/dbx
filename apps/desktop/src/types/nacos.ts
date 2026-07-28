export interface NacosCapabilities {
  supportsConfigManagement: boolean;
  supportsConfigHistory?: boolean;
  historyUnavailableReason?: "historyDisabled" | "consoleUrlMissing" | "consoleCredentialsMissing" | "consoleAuthenticationFailed";
  supportsServiceManagement: boolean;
  supportsInstanceUpdate: boolean;
  supportsRawApi: boolean;
}

export interface NacosConnectionInfo {
  serverAddr: string;
  displayServerAddr: string;
  namespace: string;
  serverVersion?: string;
  auth: string;
  capabilities: NacosCapabilities;
  raw?: unknown;
}

export interface NacosRNacosConsoleCaptcha {
  required: boolean;
  image?: string;
}

export interface NacosNamespaceInfo {
  namespace: string;
  namespaceShowName: string;
  namespaceDesc?: string;
  configCount?: number;
  quota?: number;
  namespaceType?: number;
}

export interface NacosNamespaceCreate {
  namespaceId?: string;
  namespaceName: string;
  namespaceDesc?: string;
}

export interface NacosNamespaceUpdate {
  namespaceId: string;
  namespaceName: string;
  namespaceDesc?: string;
}

export interface NacosAuthConfig {
  kind: "none" | "usernamePassword";
  username?: string;
  password?: string;
}

export type NacosImplementation = "nacos" | "rnacos";
export type NacosVersionMode = "auto" | "v2" | "v3";
export type NacosMetricsMode = "auto" | "disabled" | "custom";
export type NacosRNacosConsoleAuth = { kind: "inherit" } | { kind: "usernamePassword"; username: string; password: string };

export interface NacosAdminConfig {
  implementation?: NacosImplementation;
  versionMode?: NacosVersionMode;
  serverAddr: string;
  namespace?: string;
  contextPath?: string;
  rnacosConsoleAddr?: string;
  /** Undefined keeps the legacy behaviour: history is enabled when a console address exists. */
  rnacosHistoryEnabled?: boolean;
  rnacosConsoleAuth?: NacosRNacosConsoleAuth;
  auth?: NacosAuthConfig;
  tlsSkipVerify?: boolean;
  metricsMode?: NacosMetricsMode;
  metricsUrl?: string;
  pageSize?: number;
}

export interface NacosConfigQuery {
  namespace?: string;
  group?: string;
  dataId?: string;
  appName?: string;
  search?: string;
  pageNo?: number;
  pageSize?: number;
}

export interface NacosConfigItem {
  dataId: string;
  group: string;
  namespace: string;
  appName?: string;
  desc?: string;
  tags?: string;
  configType?: string;
  md5?: string;
  encryptedDataKey?: string;
  content?: string;
}

export interface NacosConfigList {
  pageNo: number;
  pageSize: number;
  totalCount: number;
  items: NacosConfigItem[];
}

export type NacosNamespaceScope = "currentNamespace" | "allNamespaces";

export interface NacosContentSearchRequest {
  operationId: string;
  namespace?: string;
  scope: NacosNamespaceScope;
  query: string;
  group?: string;
  dataId?: string;
  maxResults?: number;
}

export interface NacosContentMatch {
  namespace: string;
  group: string;
  dataId: string;
  lineNumber: number;
  snippet: string;
}

export interface NacosSearchFailure {
  namespace: string;
  error: string;
}

export interface NacosSearchProgress {
  operationId: string;
  phase: string;
  namespace?: string;
  scanned: number;
  total?: number;
  matched: number;
  matches: NacosContentMatch[];
  failures: NacosSearchFailure[];
  truncated: boolean;
  cancelled: boolean;
  done: boolean;
}

export interface NacosContentSearchResult {
  operationId: string;
  scanned: number;
  matches: NacosContentMatch[];
  failures: NacosSearchFailure[];
  truncated: boolean;
  cancelled: boolean;
  incomplete: boolean;
}

export type NacosConfigSelectionScope = "selected" | "filtered" | "namespace";

export interface NacosConfigSelector {
  namespace: string;
  scope: NacosConfigSelectionScope;
  keys?: NacosConfigKey[];
  query?: NacosConfigQuery;
}

export type NacosConflictPolicy = "ABORT" | "SKIP" | "OVERWRITE";

export interface NacosBatchPreviewItem {
  namespace: string;
  group: string;
  dataId: string;
  status: string;
  message?: string;
}

export interface NacosBatchPreview {
  planHash: string;
  total: number;
  created: number;
  conflicts: number;
  invalid: number;
  items: NacosBatchPreviewItem[];
  /** Web mode keeps an uploaded archive server-side behind this short-lived token. */
  archiveToken?: string;
}

export interface NacosBatchItemResult {
  namespace: string;
  group: string;
  dataId: string;
  status: string;
  message?: string;
}

export interface NacosBatchReport {
  operationId: string;
  planHash?: string;
  total: number;
  created: number;
  overwritten: number;
  skipped: number;
  failed: number;
  aborted: boolean;
  partial: boolean;
  cancelled: boolean;
  items: NacosBatchItemResult[];
}

export interface NacosConfigTransferRequest {
  operationId: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  source: NacosConfigSelector;
  targetNamespace: string;
  conflictPolicy: NacosConflictPolicy;
}

export interface NacosConfigExportRequest {
  operationId: string;
  selector: NacosConfigSelector;
  targetPath?: string;
}

export interface NacosConfigExportResult {
  operationId: string;
  exported: number;
  fileName?: string;
  path?: string;
  downloadToken?: string;
}

export interface NacosConfigImportPreviewRequest {
  operationId: string;
  namespace: string;
  sourcePath?: string;
  archiveToken?: string;
}

export interface NacosConfigImportApplyRequest {
  operationId: string;
  namespace: string;
  planHash: string;
  archiveToken?: string;
  sourcePath?: string;
  conflictPolicy: NacosConflictPolicy;
}

export interface NacosConfigKey {
  namespace?: string;
  dataId: string;
  group: string;
}

export interface NacosConfigUpsert extends NacosConfigKey {
  content: string;
  configType?: string;
  appName?: string;
  desc?: string;
  tags?: string;
}

export interface NacosConfigHistoryQuery extends NacosConfigKey {
  pageNo?: number;
  pageSize?: number;
}

export interface NacosConfigHistoryItem {
  historyId: string;
  nid?: number;
  dataId: string;
  group: string;
  namespace: string;
  appName?: string;
  operation?: string;
  operator?: string;
  lastModifiedTime?: string;
  configType?: string;
  tags?: string;
  md5?: string;
}

export interface NacosConfigHistoryList {
  pageNo: number;
  pageSize: number;
  totalCount: number;
  items: NacosConfigHistoryItem[];
}

export interface NacosConfigHistoryKey extends NacosConfigKey {
  historyId: string;
  nid?: number;
}

export interface NacosConfigRollbackRequest extends NacosConfigHistoryKey {}

export interface NacosServiceQuery {
  namespace?: string;
  groupName?: string;
  serviceName?: string;
  pageNo?: number;
  pageSize?: number;
}

export interface NacosServiceInfo {
  serviceName: string;
  groupName?: string;
  clusterCount?: number;
  ipCount?: number;
  healthyInstanceCount?: number;
  triggerFlag?: string;
}

export interface NacosServiceList {
  pageNo: number;
  pageSize: number;
  totalCount: number;
  items: NacosServiceInfo[];
}

export interface NacosInstanceQuery {
  namespace?: string;
  serviceName: string;
  groupName?: string;
  clusters?: string;
}

export interface NacosInstanceInfo {
  ip: string;
  port: number;
  serviceName?: string;
  clusterName?: string;
  groupName?: string;
  healthy?: boolean;
  enabled?: boolean;
  ephemeral?: boolean;
  weight?: number;
  metadata?: unknown;
}

export interface NacosInstanceUpdate {
  namespace?: string;
  serviceName: string;
  ip: string;
  port: number;
  groupName?: string;
  clusterName?: string;
  healthy?: boolean;
  enabled?: boolean;
  ephemeral?: boolean;
  weight?: number;
  metadata?: unknown;
}

export interface NacosDashboardQuery {
  namespace?: string;
}

export interface NacosDashboardMetrics {
  status?: string;
  serviceCount?: number;
  instanceCount?: number;
  subscribeCount?: number;
  raftNotifyTaskCount?: number;
  responsibleServiceCount?: number;
  responsibleInstanceCount?: number;
  clientCount?: number;
  connectionBasedClientCount?: number;
  ephemeralIpPortClientCount?: number;
  persistentIpPortClientCount?: number;
  responsibleClientCount?: number;
  cpu?: number;
  load?: number;
  mem?: number;
}

export interface NacosPrometheusSource {
  kind: NacosImplementation;
  endpoint: string;
  fingerprint?: string;
}

export interface NacosPrometheusResourceMetrics {
  cpuRatio?: number;
  memoryRatio?: number;
  memoryUsedBytes?: number;
  memoryMaxBytes?: number;
  rssBytes?: number;
  vmsBytes?: number;
  systemTotalMemoryBytes?: number;
  load1m?: number;
  jvmDaemonThreads?: number;
  gcPauseCount?: number;
}

export interface NacosPrometheusTrafficMetrics {
  httpRequestsTotal?: number;
  grpcRequestsTotal?: number;
  httpErrorsTotal?: number;
  grpcErrorsTotal?: number;
  httpDurationSecondsTotal?: number;
  httpDurationCount?: number;
  grpcDurationSecondsTotal?: number;
  grpcDurationCount?: number;
  httpP50Ms?: number;
  httpP95Ms?: number;
  httpP99Ms?: number;
  grpcP50Ms?: number;
  grpcP95Ms?: number;
  grpcP99Ms?: number;
  executorPoolSize?: number;
  executorActiveCount?: number;
  executorQueuedTasks?: number;
}

export interface NacosPrometheusConfigMetrics {
  configCount?: number;
  getConfigTotal?: number;
  publishTotal?: number;
  longPolling?: number;
  listenerClients?: number;
  listenerKeys?: number;
  notifyTasks?: number;
  notifyClientTasks?: number;
  dumpTasks?: number;
  subscriberCount?: number;
}

export interface NacosPrometheusNamingMetrics {
  serviceCount?: number;
  instanceCount?: number;
  subscriberCount?: number;
  connectionCount?: number;
  totalPush?: number;
  failedPush?: number;
  emptyPush?: number;
  pushPendingTasks?: number;
  avgPushCostMs?: number;
  maxPushCostMs?: number;
  leaderStatus?: number;
}

export interface NacosPrometheusSnapshot {
  source: NacosPrometheusSource;
  resource: NacosPrometheusResourceMetrics;
  traffic: NacosPrometheusTrafficMetrics;
  config: NacosPrometheusConfigMetrics;
  naming: NacosPrometheusNamingMetrics;
}

export interface NacosClusterNode {
  address: string;
  ip?: string;
  port?: number;
  state?: string;
  alive?: boolean;
  site?: string;
  weight?: number;
  lastRefreshTime?: string;
}

export interface NacosDashboardSnapshot {
  namespace: string;
  namespaceCount?: number;
  configCount?: number;
  serviceCount?: number;
  metrics?: NacosDashboardMetrics;
  prometheus?: NacosPrometheusSnapshot;
  nodes: NacosClusterNode[];
  warnings: string[];
}

export interface NacosRawRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface NacosRawResponse {
  status: number;
  body: unknown;
  text?: string;
}
