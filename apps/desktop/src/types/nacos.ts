export interface NacosCapabilities {
  supportsConfigManagement: boolean;
  supportsConfigHistory?: boolean;
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

export interface NacosAdminConfig {
  serverAddr: string;
  namespace?: string;
  contextPath?: string;
  auth?: NacosAuthConfig;
  tlsSkipVerify?: boolean;
  pageSize?: number;
}

export interface NacosConfigQuery {
  namespace?: string;
  group?: string;
  dataId?: string;
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
