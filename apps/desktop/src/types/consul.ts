import type { KvInt64, KvValue } from "@/lib/backend/tauri";

export type ConsulCapabilityStatus = "supported" | "unsupported" | "disabled" | "forbidden" | "unknown";

export interface ConsulScope {
  datacenter: string;
  namespace: string;
  partition: string;
}

export interface ConsulResponseMetadata {
  index: KvInt64 | null;
  filteredByAcls: boolean | null;
  knownLeader: boolean | null;
  lastContact: KvInt64 | null;
  queryBackend: string | null;
}

export interface ConsulCapabilities {
  version: string | null;
  datacenter: string | null;
  nodeName: string | null;
  server: boolean | null;
  edition: string | null;
  agent: ConsulCapabilityStatus;
  catalog: ConsulCapabilityStatus;
  health: ConsulCapabilityStatus;
  sessions: ConsulCapabilityStatus;
  acl: ConsulCapabilityStatus;
  authMethods: ConsulCapabilityStatus;
  bindingRules: ConsulCapabilityStatus;
  templatedPolicies: ConsulCapabilityStatus;
  namespaces: ConsulCapabilityStatus;
  partitions: ConsulCapabilityStatus;
  configEntries: ConsulCapabilityStatus;
  intentions: ConsulCapabilityStatus;
  peering: ConsulCapabilityStatus;
  exportedServices: ConsulCapabilityStatus;
  preparedQueries: ConsulCapabilityStatus;
  events: ConsulCapabilityStatus;
  coordinates: ConsulCapabilityStatus;
  operatorAutopilot: ConsulCapabilityStatus;
  operatorRaft: ConsulCapabilityStatus;
  operatorKeyring: ConsulCapabilityStatus;
  operatorUsage: ConsulCapabilityStatus;
  operatorLicense: ConsulCapabilityStatus;
  audit: ConsulCapabilityStatus;
}

export interface ConsulKvRecord {
  key: string;
  value: KvValue;
  flags: KvInt64;
  createIndex: KvInt64;
  modifyIndex: KvInt64;
  lockIndex: KvInt64;
  session: string | null;
}

export interface ConsulRecursiveListResponse {
  entries: ConsulKvRecord[];
  index: KvInt64 | null;
  filteredByAcls: boolean | null;
  totalValueBytes: number;
  complete: boolean;
}

export interface ConsulSearchRequest {
  requestId: string;
  prefix: string;
  query: string;
  searchKeys: boolean;
  searchValues: boolean;
  caseSensitive: boolean;
  limit: number;
  maxScan: number;
  generation: number;
}

export interface ConsulSearchMatch extends ConsulKvRecord {
  matchesKey: boolean;
  matchesValue: boolean;
}

export interface ConsulSearchResponse {
  matches: ConsulSearchMatch[];
  scanned: number;
  matched: number;
  limited: boolean;
  filteredByAcls: boolean | null;
}

export interface ConsulSearchProgress {
  running: boolean;
  scanned: number;
  cancelled: boolean;
}

export type ConsulExportScopeKind = "key" | "prefix";

export interface ConsulExportRequest {
  path: string;
  kind: ConsulExportScopeKind;
}

export interface ConsulBundleScope {
  datacenter: string;
  namespace: string;
  partition: string;
}

export interface ConsulBundleEntry {
  key: string;
  value: KvValue;
  flags: KvInt64;
  createIndex: KvInt64 | null;
  modifyIndex: KvInt64 | null;
}

export interface ConsulKvBundle {
  format: "dbx-consul-kv-bundle";
  version: 1;
  exportedAtUnixMs: number;
  prefix: string;
  scopeKind: ConsulExportScopeKind;
  source: ConsulBundleScope;
  entries: ConsulBundleEntry[];
}

export type ConsulImportConflictPolicy = "abort" | "skip" | "cas";
export type ConsulImportOperation = "create" | "update" | "unchanged" | "skipped" | "conflict" | "locked";

export interface ConsulImportRequest {
  bundle: ConsulKvBundle;
  policy: ConsulImportConflictPolicy;
  previewId?: string | null;
}

export interface ConsulImportPreviewRow {
  key: string;
  operation: ConsulImportOperation;
  expectedModifyIndex: KvInt64 | null;
  targetSession: string | null;
  reason: string | null;
}

export interface ConsulImportPreview {
  previewId: string;
  rows: ConsulImportPreviewRow[];
  canApply: boolean;
  creates: number;
  updates: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
}

export type ConsulImportOutcome = "succeeded" | "conflicted" | "skipped" | "failed";

export interface ConsulImportResultItem {
  key: string;
  outcome: ConsulImportOutcome;
  message: string | null;
  batch: number | null;
  opIndex: number | null;
}

export interface ConsulImportReport {
  items: ConsulImportResultItem[];
  succeeded: number;
  conflicted: number;
  skipped: number;
  failed: number;
  atomic: boolean;
}

export interface ConsulDeleteCandidate {
  key: string;
  modifyIndex: KvInt64;
  session: string | null;
}

export interface ConsulDeletePrefixPreview {
  prefix: string;
  candidates: ConsulDeleteCandidate[];
  filteredByAcls: boolean | null;
  complete: boolean;
  canExecute: boolean;
  locked: number;
}

export interface ConsulDeletePrefixRequest {
  prefix: string;
  expected: ConsulDeleteCandidate[];
}

export type ConsulDeleteOutcome = "succeeded" | "conflicted" | "failed";

export interface ConsulDeleteResultItem {
  key: string;
  outcome: ConsulDeleteOutcome;
  message: string | null;
  batch: number | null;
  opIndex: number | null;
}

export type ConsulTxnVerb = "get" | "get-tree" | "set" | "cas" | "delete" | "delete-cas" | "delete-tree" | "lock" | "unlock" | "check-index" | "check-not-exists" | "check-session";

export interface ConsulTxnKvOperation {
  verb: ConsulTxnVerb;
  key: string;
  value: KvValue | null;
  flags: KvInt64 | null;
  index: KvInt64 | null;
  session: string | null;
}

export interface ConsulTxnRequest {
  operations: ConsulTxnKvOperation[];
}
export interface ConsulTxnError {
  opIndex: number;
  message: string;
}
export interface ConsulTxnKvResult {
  key: string;
  value: KvValue | null;
  flags: KvInt64;
  createIndex: KvInt64;
  modifyIndex: KvInt64;
  lockIndex: KvInt64;
  session: string | null;
}
export interface ConsulTxnResult {
  committed: boolean;
  errors: ConsulTxnError[];
  results: ConsulTxnKvResult[];
}

export interface ConsulBlockingRequest {
  operationId: string;
  generation: number;
  key: string;
  prefix: boolean;
  index: KvInt64 | null;
  waitSeconds: number;
}

export interface ConsulBlockingResponse {
  entries: ConsulKvRecord[];
  metadata: ConsulResponseMetadata;
  changed: boolean;
  timedOut: boolean;
  indexReset: boolean;
}

export type ConsulDomainWatchTarget =
  | { kind: "catalogNodes" }
  | { kind: "catalogServices" }
  | { kind: "catalogServiceNodes"; service: string }
  | { kind: "catalogNodeServices"; node: string }
  | { kind: "healthNode"; node: string }
  | { kind: "healthServiceChecks"; service: string }
  | { kind: "healthServiceInstances"; service: string; passing: boolean | null }
  | { kind: "healthState"; state: string };

export interface ConsulDomainWatchRequest {
  operationId: string;
  generation: number;
  target: ConsulDomainWatchTarget;
  index: KvInt64 | null;
  waitSeconds: number;
}

export type ConsulDomainWatchItems = ConsulCatalogNode[] | Record<string, string[]> | ConsulCatalogServiceNode[] | ConsulNodeServices | ConsulHealthCheck[] | ConsulServiceInstance[];

export interface ConsulDomainWatchResponse<T extends ConsulDomainWatchItems> {
  items: T;
  metadata: ConsulResponseMetadata;
  changed: boolean;
  timedOut: boolean;
  indexReset: boolean;
}

export interface ConsulWatchEvent {
  connectionId: string;
  operationId: string;
  generation: number;
  result: ConsulBlockingResponse | null;
  error: string | null;
}

export interface ConsulPreparedQueryService {
  Service: string;
  Near: string;
  OnlyPassing: boolean;
  Tags: string[];
}
export interface ConsulPreparedQuery {
  ID: string;
  Name: string;
  Session: string;
  Service: ConsulPreparedQueryService;
  CreateIndex: KvInt64;
  ModifyIndex: KvInt64;
}
export interface ConsulPreparedQueryInput {
  name: string;
  session: string;
  service: ConsulPreparedQueryService;
}
export interface ConsulPreparedQueryExecuteRequest {
  query: string;
  limit: number;
  connect: boolean;
}
export interface ConsulPreparedNodeIdentity {
  Node: string;
  Address: string;
  Datacenter: string;
}
export interface ConsulPreparedServiceIdentity {
  ID: string;
  Service: string;
  Address: string;
  Port: number;
  Tags: string[];
}
export interface ConsulPreparedQueryNode {
  Node: ConsulPreparedNodeIdentity;
  Service: ConsulPreparedServiceIdentity;
}
export interface ConsulPreparedQueryExecuteResponse {
  Service: string;
  Nodes: ConsulPreparedQueryNode[];
  DNS: { TTL: string };
  Datacenter: string;
}
export interface ConsulEventFireRequest {
  name: string;
  payloadBase64: string;
  nodeFilter: string;
  serviceFilter: string;
  tagFilter: string;
}
export interface ConsulEvent {
  ID: string;
  Name: string;
  Payload: string | null;
  NodeFilter: string;
  ServiceFilter: string;
  TagFilter: string;
  LTime: KvInt64;
}
export interface ConsulCoordinate {
  Node: string;
  Segment: string;
  Coord: { Vec: number[]; Error: number; Adjustment: number; Height: number };
}

export type ConsulOperatorReadKind = "autopilot_configuration" | "autopilot_health" | "autopilot_state" | "raft_configuration" | "usage" | "license" | "audit";
export interface ConsulOperatorDocument {
  kind: string;
  fields: Array<{ name: string; value: string }>;
}
export interface ConsulAutopilotUpdate {
  CleanupDeadServers?: boolean | null;
  LastContactThreshold?: string | null;
  MaxTrailingLogs?: number | null;
  MinQuorum?: number | null;
  ServerStabilizationTime?: string | null;
  RedundancyZoneTag?: string | null;
  DisableUpgradeMigration?: boolean | null;
  UpgradeVersionTag?: string | null;
}
export interface ConsulSnapshot {
  dataBase64: string;
  sizeBytes: number;
  datacenter: string;
}
export interface ConsulSnapshotRestoreRequest {
  snapshotBase64: string;
  targetDatacenter: string;
  confirmation: string;
}
export interface ConsulRaftWriteRequest {
  serverId: string | null;
  address: string | null;
  confirmation: string;
}
export interface ConsulKeyringWriteRequest {
  operation: "install" | "use" | "remove";
  key: string;
  confirmation: string;
}
export interface ConsulLicenseWriteRequest {
  license: string;
  confirmation: string;
}

export interface ConsulDeletePrefixReport {
  items: ConsulDeleteResultItem[];
  succeeded: number;
  conflicted: number;
  failed: number;
  atomic: boolean;
}

export interface ConsulResponseMetadata {
  index: KvInt64 | null;
  filteredByAcls: boolean | null;
  knownLeader: boolean | null;
  lastContact: KvInt64 | null;
  queryBackend: string | null;
}

export interface ConsulListResponse<T> {
  items: T;
  metadata: ConsulResponseMetadata;
}

export interface ConsulReadOptions {
  filter?: string | null;
  near?: string | null;
  index?: string | null;
  wait?: string | null;
}

export interface ConsulAgentIdentity {
  node: string;
  address: string;
  datacenter: string;
  version: string | null;
  server: boolean | null;
  revision: string | null;
  segment: string | null;
}

export interface ConsulAgentMember {
  Name: string;
  Addr: string;
  Port: number;
  Tags: Record<string, string>;
  Status: number;
}

export interface ConsulCatalogNode {
  ID: string;
  Node: string;
  Address: string;
  Datacenter: string;
  TaggedAddresses: Record<string, string>;
  NodeMeta: Record<string, string>;
  CreateIndex: number;
  ModifyIndex: number;
}

export interface ConsulServiceAddress {
  Address: string;
  Port: number;
}

export interface ConsulServiceWeights {
  Passing: number;
  Warning: number;
}

export interface ConsulCatalogServiceNode {
  ID: string;
  Node: string;
  Address: string;
  Datacenter: string;
  TaggedAddresses: Record<string, string>;
  NodeMeta: Record<string, string>;
  ServiceKind: string;
  ServiceID: string;
  ServiceName: string;
  ServiceTags: string[];
  ServiceAddress: string;
  ServicePort: number;
  ServiceMeta: Record<string, string>;
  ServiceTaggedAddresses: Record<string, ConsulServiceAddress>;
  ServiceWeights: ConsulServiceWeights;
  CreateIndex: number;
  ModifyIndex: number;
}

export interface ConsulCatalogService {
  ID: string;
  Service: string;
  Tags: string[];
  Address: string;
  TaggedAddresses: Record<string, ConsulServiceAddress>;
  Meta: Record<string, string>;
  Port: number;
  Weights: ConsulServiceWeights;
}

export interface ConsulNodeServices {
  Node: ConsulCatalogNode;
  Services: Record<string, ConsulCatalogService>;
}

export interface ConsulHealthCheckDefinition {
  HTTP: string;
  TCP: string;
  GRPC: string;
  Interval: string;
  Timeout: string;
  TTL: string;
}

export interface ConsulHealthCheck {
  Node: string;
  CheckID: string;
  Name: string;
  Status: "passing" | "warning" | "critical" | string;
  Notes: string;
  Output: string;
  ServiceID: string;
  ServiceName: string;
  ServiceTags: string[];
  Type: string;
  ExposedPort: number;
  Definition: ConsulHealthCheckDefinition;
  CreateIndex: number;
  ModifyIndex: number;
  Maintenance: boolean;
}

export interface ConsulHealthService {
  ID: string;
  Service: string;
  Tags: string[];
  Address: string;
  TaggedAddresses: Record<string, ConsulServiceAddress>;
  Meta: Record<string, string>;
  Port: number;
  Weights: ConsulServiceWeights;
  Kind: string;
}

export interface ConsulServiceInstance {
  Node: ConsulCatalogNode;
  Service: ConsulHealthService;
  Checks: ConsulHealthCheck[];
}

export interface ConsulAgentService {
  Kind: string;
  ID: string;
  Service: string;
  Tags: string[];
  Meta: Record<string, string>;
  Port: number;
  Address: string;
  TaggedAddresses: Record<string, ConsulServiceAddress>;
  Weights: ConsulServiceWeights;
  EnableTagOverride: boolean;
  Datacenter: string;
}

export interface ConsulAgentProxyRegistration {
  destinationServiceName: string;
  destinationServiceId: string;
  localServiceAddress: string;
  localServicePort: number;
  localServicePorts?: string[];
  localServiceSocketPath?: string;
  mode?: string;
  transparentProxy?: ConsulAgentTransparentProxy | null;
  config?: Record<string, unknown>;
  upstreams: ConsulAgentUpstream[];
  meshGateway?: ConsulAgentMeshGateway | null;
  expose?: ConsulAgentExpose | null;
}

export interface ConsulAgentTransparentProxy {
  outboundListenerPort: number;
  dialedDirectly: boolean;
}

export interface ConsulAgentMeshGateway {
  mode: "" | "local" | "remote" | "none" | string;
}

export interface ConsulAgentExposePath {
  path: string;
  protocol: "http" | "http2" | string;
  localPathPort: number;
  listenerPort: number;
}

export interface ConsulAgentExpose {
  checks: boolean;
  paths: ConsulAgentExposePath[];
}

export interface ConsulAgentUpstream {
  destinationType: "service" | "prepared_query" | string;
  destinationName: string;
  destinationPort?: number;
  destinationNamespace?: string;
  destinationPartition?: string;
  destinationPeer?: string;
  localBindAddress: string;
  localBindPort: number;
  localBindSocketPath?: string;
  localBindSocketMode?: string;
  datacenter: string;
  meshGateway?: ConsulAgentMeshGateway | null;
  config?: Record<string, unknown>;
}

export interface ConsulAgentServicePort {
  name: string;
  port: number;
  default: boolean;
}

export interface ConsulAgentConnectRegistration {
  native: boolean;
  sidecarService?: ConsulAgentServiceRegistration | null;
}

export type ConsulAgentCheckDefinition =
  | { type: "http"; url: string; method: string; interval: string; timeout: string; tlsSkipVerify: boolean }
  | { type: "tcp"; address: string; interval: string; timeout: string }
  | { type: "grpc"; address: string; interval: string; timeout: string; tls: boolean }
  | { type: "ttl"; ttl: string }
  | { type: "docker"; containerId: string; shell: string; args: string[]; interval: string; timeout: string }
  | { type: "script"; args: string[]; interval: string; timeout: string };

export interface ConsulAgentCheckRegistration {
  id: string;
  name: string;
  notes: string;
  serviceId: string;
  status: string;
  definition: ConsulAgentCheckDefinition;
}

export interface ConsulAgentServiceRegistration {
  id: string;
  name: string;
  tags: string[];
  address: string;
  port: number;
  meta: Record<string, string>;
  weights: ConsulServiceWeights;
  kind: string;
  enableTagOverride: boolean;
  taggedAddresses?: Record<string, ConsulServiceAddress>;
  ports?: ConsulAgentServicePort[];
  proxy: ConsulAgentProxyRegistration | null;
  connect?: ConsulAgentConnectRegistration | null;
  checks: ConsulAgentCheckRegistration[];
}

export interface ConsulAgentWriteResult {
  target: ConsulAgentIdentity;
}

export type ConsulCheckStatus = "passing" | "warning" | "critical";

export interface ConsulSession {
  ID: string;
  Name: string;
  Node: string;
  LockDelay: number;
  Behavior: "release" | "delete" | string;
  TTL: string;
  NodeChecks: string[];
  ServiceChecks: ConsulSessionServiceCheck[];
  Namespace: string;
  Partition: string;
  CreateIndex: number;
  ModifyIndex: number;
}

export interface ConsulSessionServiceCheck {
  ID: string;
  Namespace: string;
}

export interface ConsulSessionCreateRequest {
  name: string;
  node: string;
  lockDelay?: string | null;
  behavior: "release" | "delete";
  ttl?: string | null;
  nodeChecks: string[];
  serviceChecks: ConsulSessionServiceCheck[];
}

export interface ConsulSessionHeldKey {
  key: string;
  modifyIndex: KvInt64;
}
export interface ConsulSessionKeysResponse {
  items: ConsulKvRecord[];
  complete: boolean;
  filteredByAcls: boolean;
}
export interface ConsulSessionDestroyImpact {
  session: ConsulSession;
  heldKeys: ConsulSessionHeldKey[];
  complete: boolean;
  filteredByAcls: boolean;
}
export interface ConsulSessionDestroyRequest {
  id: string;
  expectedBehavior: string;
  expectedHeldKeys: ConsulSessionHeldKey[];
}

export interface ConsulLockRequest {
  key: string;
  session: string;
  value: KvValue;
  flags?: KvInt64 | null;
  expectedModifyIndex?: KvInt64 | null;
}

export interface ConsulLockResponse {
  acquired: boolean;
  key: string;
  session: string;
}

export type ConsulAclKind = "token" | "policy" | "role" | "authMethod" | "bindingRule" | "templatedPolicy";
export interface ConsulAclLink {
  ID?: string;
  Name?: string;
}
export interface ConsulAclToken {
  AccessorID?: string;
  SecretID?: string;
  Description?: string;
  Local?: boolean;
  AuthMethod?: string;
  Policies?: ConsulAclLink[];
  Roles?: ConsulAclLink[];
  ServiceIdentities?: unknown[];
  NodeIdentities?: unknown[];
  TemplatedPolicies?: unknown[];
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulAclPolicy {
  ID?: string;
  Name?: string;
  Description?: string;
  Rules?: string;
  Datacenters?: string[];
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulAclRole {
  ID?: string;
  Name?: string;
  Description?: string;
  Policies?: ConsulAclLink[];
  ServiceIdentities?: unknown[];
  NodeIdentities?: unknown[];
  TemplatedPolicies?: unknown[];
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulAclAuthMethod {
  Name?: string;
  Type?: string;
  DisplayName?: string;
  Description?: string;
  MaxTokenTTL?: string;
  TokenLocality?: string;
  Config?: unknown;
}
export interface ConsulAclBindingRule {
  ID?: string;
  Description?: string;
  AuthMethod?: string;
  Selector?: string;
  BindType?: string;
  BindName?: string;
  BindVars?: unknown;
}
export interface ConsulAclTemplatedPolicy {
  TemplateName?: string;
  Schema?: unknown;
}
export type ConsulAclList =
  | { kind: "token"; items: ConsulAclToken[] }
  | { kind: "policy"; items: ConsulAclPolicy[] }
  | { kind: "role"; items: ConsulAclRole[] }
  | { kind: "authMethod"; items: ConsulAclAuthMethod[] }
  | { kind: "bindingRule"; items: ConsulAclBindingRule[] }
  | { kind: "templatedPolicy"; items: ConsulAclTemplatedPolicy[] };
export type ConsulAclItem =
  | { kind: "token"; item: ConsulAclToken }
  | { kind: "policy"; item: ConsulAclPolicy }
  | { kind: "role"; item: ConsulAclRole }
  | { kind: "authMethod"; item: ConsulAclAuthMethod }
  | { kind: "bindingRule"; item: ConsulAclBindingRule }
  | { kind: "templatedPolicy"; item: ConsulAclTemplatedPolicy };
export type ConsulAclWrite = Exclude<ConsulAclItem, { kind: "templatedPolicy" }>;
export interface ConsulAclReferences {
  tokenAccessorIds: string[];
  roleIds: string[];
  bindingRuleIds: string[];
  complete: boolean;
  filteredByAcls: boolean;
}

export type ConsulEnterpriseKind = "namespace" | "partition";
export interface ConsulNamespaceAcls {
  PolicyDefaults?: unknown[];
  RoleDefaults?: unknown[];
}
export interface ConsulNamespace {
  Name?: string;
  Partition?: string;
  Description?: string;
  Meta?: Record<string, string>;
  ACLs?: ConsulNamespaceAcls;
  DeletedAt?: string | null;
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulPartition {
  Name?: string;
  Description?: string;
  Meta?: Record<string, string>;
  DeletedAt?: string | null;
  CreateIndex?: number;
  ModifyIndex?: number;
}
export type ConsulEnterpriseList = { kind: "namespace"; items: ConsulNamespace[] } | { kind: "partition"; items: ConsulPartition[] };
export type ConsulEnterpriseItem = { kind: "namespace"; item: ConsulNamespace } | { kind: "partition"; item: ConsulPartition };
export type ConsulEnterpriseWrite = ConsulEnterpriseItem;
export interface ConsulScopeImpact {
  services: number;
  nodes: number;
  kvKeys: number;
  healthChecks: number;
  sessions: number;
  configEntries: number;
  intentions: number;
  peerings: number;
  namespaces: number;
  aclTokens: number;
  aclPolicies: number;
  aclRoles: number;
  aclAuthMethods: number;
  aclBindingRules: number;
  complete: boolean;
  filteredByAcls: boolean;
  unavailableResources: string[];
}

export interface ConsulConfigEntry {
  kind: string;
  name: string;
  modifyIndex: number;
  raw: Record<string, unknown>;
}
export interface ConsulConfigEntryApply {
  kind: string;
  name: string;
  expectedModifyIndex: number;
  raw: Record<string, unknown>;
}
export interface ConsulIntention {
  ID?: string;
  Description?: string;
  SourceName?: string;
  DestinationName?: string;
  SourceNamespace?: string;
  DestinationNamespace?: string;
  SourcePartition?: string;
  DestinationPartition?: string;
  Action?: string;
  Permissions?: unknown[];
  Precedence?: number;
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulIntentionMatchRequest {
  by: "source" | "destination";
  name: string;
}
export interface ConsulIntentionExactRequest {
  source: string;
  destination: string;
}
export interface ConsulIntentionCheckRequest {
  source: string;
  destination: string;
}
export interface ConsulIntentionCheckResponse {
  Allowed: boolean;
}
export interface ConsulDiscoveryChain {
  ServiceName?: string;
  Namespace?: string;
  Partition?: string;
  Datacenter?: string;
  Protocol?: string;
  StartNode?: string;
  Nodes?: Record<string, unknown>;
  Targets?: Record<string, unknown>;
}
export interface ConsulPeering {
  ID?: string;
  Name?: string;
  Partition?: string;
  State?: string;
  PeerID?: string;
  PeerServerName?: string;
  PeerServerAddresses?: string[];
  ImportedServices?: string[];
  ExportedServices?: string[];
  CreateIndex?: number;
  ModifyIndex?: number;
}
export interface ConsulPeeringGenerateRequest {
  PeerName: string;
  Partition?: string;
  Meta?: unknown;
}
export interface ConsulPeeringToken {
  PeeringToken: string;
}
export interface ConsulPeeringEstablishRequest {
  PeerName: string;
  PeeringToken: string;
  Partition?: string;
}
export interface ConsulExportedService {
  Service?: string;
  Namespace?: string;
  Partition?: string;
  Consumers?: unknown[];
}
