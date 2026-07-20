<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, DatabaseType, HttpTunnelConfig, IdentifierCase, JdbcDriverInfo, JdbcLocalBundleInfo, JdbcMavenBundleInfo, ProxyTunnelConfig, SshConfigHostEntry, SshTunnelConfig, TransportLayerConfig } from "@/types/database";
import type { InfluxDbExternalConfig, InfluxDbVersion } from "@/types/influxdb";
import type { MqAdminConfig, MqAuth, MqSystemKind } from "@/types/mq";
import type { NacosAdminConfig, NacosAuthConfig } from "@/types/nacos";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } from "@/stores/connectionStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { detachTunnelProfileLayer, tunnelProfileReferenceLayer, tunnelProfileSummary } from "@/lib/connection/tunnelProfiles";
import { applySshConfigHostAliasPrefill as prefillSshConfigHostAlias } from "@/lib/connection/sshConfigHosts";
import { canPersistConnectionTestResult, connectionEditDraftSyncAction } from "./connectionEditDraftSync";
import { REDIS_SCAN_PAGE_SIZE_DEFAULT, REDIS_SCAN_PAGE_SIZE_MIN, REDIS_SCAN_PAGE_SIZE_MAX, REDIS_SCAN_PAGE_SIZE_OPTIONS } from "@/lib/redis/redisKeyPattern";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { applyParsedConnectionUrl, normalizeMongoConnectionString, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import { parseConnectionDeepLink, type ConnectionDeepLinkDraft } from "@/lib/connection/connectionDeepLink";
import { connectionUrlPlaceholder as getUrlPlaceholder } from "@/lib/connection/connectionPresentation";
import { h2ConnectionModeForConfig, h2FileJdbcUrlWithPath, h2FilePathFromJdbcUrl, isH2SplitJdbcUrl, type H2ConnectionMode } from "@/lib/database/h2Connection";
import { firstZooKeeperEndpoint, normalizeZooKeeperConnectString } from "@/lib/zookeeper/zookeeperConnection";
import { isLocalFileTypeDb } from "@/lib/connection/connectionFile";
import { MQ_PINNED_VERSION_OPTIONS, pinnedVersionToSelection, selectionToPinnedVersion } from "@/lib/mq/mqPinnedVersionOptions";
import { mongodbAuthFailureHint, mongoUrlParam, mongoUrlParamIsTrue, normalizeMongoTlsFormState, setMongoUrlParam, setMongoUrlParamBoolean } from "@/lib/mongo/mongoConnectionOptions";
import { mysqlCleartextPasswordAuthEnabled, setMysqlCleartextPasswordAuthEnabled } from "@/lib/database/mysqlConnectionOptions";
import { copyToClipboard } from "@/lib/common/clipboard";
import { configuredDatabaseProductName, connectionConfigFingerprint, databaseInfoCopyText, databaseInfoRows, normalizeDatabaseConnectionInfo, type DatabaseInfoField } from "@/lib/connection/connectionDatabaseInfo";
import { agentDriverInstallKey, appendAgentDriverUpdateHint, hasAgentDriverUpdate, showAgentDriverInstallHint, type AgentDriverInstallState, type DriverStoreFocus } from "@/lib/connection/agentDriverInstallHint";
import { prestoSqlBuiltinDriverPaths } from "@/lib/database/prestoSqlBuiltinDriver";
import { JDBCX_DEFAULT_URL, JDBCX_DRIVER_PROFILE, JDBCX_JDBC_DRIVER_CLASS, ensureJdbcxRuntimeDrivers, isJdbcxRuntimeBundle, isJdbcxRuntimePath, jdbcxHighPrivilegeExtensionsEnabled, setJdbcxHighPrivilegeExtensionsEnabled } from "@/lib/database/jdbcxBuiltinDriver";
import { SQLITE_DATABASE_FILE_EXTENSIONS } from "@/lib/database/databaseFileDetection";
import { connectionAttemptOriginalErrorMessage, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import { appendConnectionErrorHints, isJdbcMissingRuntimeDependencyError } from "@/lib/connection/connectionErrorHints";
import { postgresTlsModeForForm } from "@/lib/connection/postgresTlsMode";
import { normalizeKafkaBootstrapServers } from "@/lib/connection/kafkaBootstrapServers";
import { normalizeRocketmqNamesrvAddr } from "@/lib/connection/rocketmqNamesrv";
import { detectMqUiAuthKind, isMqAuthKindAllowedForSystem, type MqUiAuthKind } from "@/lib/connection/mqAuth";
import { driverInstallProgressPercent, type DriverInstallProgress } from "@/lib/connection/driverInstallProgressUi";
import { isSqlServerLegacyCompatibilityMode, requiresSqlServerLegacyCompatibilityComponent, setSqlServerLegacyCompatibilityMode, SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY } from "@/lib/connection/sqlServerLegacyCompatibility";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronRight,
  CircleHelp,
  Copy,
  Database as DatabaseLucide,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  GripVertical,
  Grid3X3,
  KeyRound,
  Link2,
  List,
  ListFilter,
  Loader2,
  Pencil,
  Pipette,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
} from "@lucide/vue";
import { buildDraftVisibleDatabasesConnectionId, connectionCanChooseVisibleDatabases, initialVisibleDatabaseSelection, visibleDatabaseSelectionIsStale } from "@/lib/connection/connectionVisibleDatabases";
import { canSaveVisibleDatabaseSelection, connectionUsesVisibleSchemaFilter, filterDatabaseNamesForVisiblePicker, isSystemDatabaseName, normalizeVisibleDatabaseSelection, buildDraftVisibleSchemasConnectionId, normalizeVisibleSchemaSelection } from "@/lib/database/visibleDatabases";
import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import VisibleSchemasDialog from "@/components/sidebar/VisibleSchemasDialog.vue";
import CloudflareD1ConnectionFields from "@/components/connection/CloudflareD1ConnectionFields.vue";
import { oceanbaseModeConnectionPatch, oceanbaseSubModeFromConfig } from "@/lib/database/oceanbaseConnectionMode";
import { translateBackendError } from "@/i18n/backend-errors";
import { applyHiveKerberosSubmitConfig, hiveKerberosFormConfig, type HiveKerberosAuthMode } from "@/lib/database/hiveKerberosOptions";
import { hasCloudflareD1Credentials, isCloudflareD1Connection, normalizeCloudflareD1Connection } from "@/lib/connection/cloudflareD1";
import { buildElasticsearchExternalConfig, elasticsearchConnectionModeFromConfig, elasticsearchKibanaBasePathFromConfig, type ElasticsearchConnectionMode } from "@/lib/connection/elasticsearchKibanaProxy";

type DbOption = { value: string; label: string };
type DbCategory = { key: string; title: string; options: DbOption[] };
type DialogStep = "select" | "config";
type DbPickerView = "icon" | "list";
export type ConfigTab = "connection" | "advanced" | "tls" | "transport";
type ProductionScope = "connection" | "databases";
type MqTokenSigningMode = "none" | "hs256" | "rs256";
type NacosAuthKind = NacosAuthConfig["kind"];
type DremioConnectionMode = "arrow-flight-sql" | "legacy";
type JdbcDriverSelectItem = {
  id: string;
  label: string;
  paths: string[];
  jdbcxRuntime: boolean;
};

const DREMIO_ARROW_FLIGHT_SQL_JDBC_URL = "jdbc:arrow-flight-sql://127.0.0.1:32010";
const DREMIO_ARROW_FLIGHT_SQL_JDBC_DRIVER_CLASS = "org.apache.arrow.driver.jdbc.ArrowFlightJdbcDriver";
const DREMIO_LEGACY_JDBC_URL = "jdbc:dremio:direct=127.0.0.1:31010";
const DREMIO_LEGACY_JDBC_DRIVER_CLASS = "com.dremio.jdbc.Driver";
const NACOS_DEFAULT_CONSOLE_URL = "http://127.0.0.1:8085";
const NACOS_LEGACY_SERVER_PORT = "8848";
const NACOS_DOCKER_CONSOLE_PORT = "8085";
const DEFAULT_SSH_USER = "root";

type LegacyTransportFields = {
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key_path?: string;
  ssh_key_passphrase?: string;
  ssh_expose_lan?: boolean;
  ssh_connect_timeout_secs?: number;
  ssh_tunnels?: SshTunnelConfig[];
  proxy_enabled?: boolean;
  proxy_type?: "socks5" | "http";
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
};
type LegacyConnectionConfig = ConnectionConfig & LegacyTransportFields;
type ConnectionForm = Omit<ConnectionConfig, "id">;
type ConnectionTestState = ConnectionTestResult & { ok: boolean };
type SuccessfulConnectionTest = { result: ConnectionTestResult; config: ConnectionConfig };

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const open = defineModel<boolean>("open", { default: false });
const isDesktop = isTauriRuntime();

const props = defineProps<{
  editConfig?: ConnectionConfig;
  prefillConfig?: ConnectionDeepLinkDraft | null;
  initialTab?: ConfigTab;
}>();

const emit = defineEmits<{
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
  openDriverStore: [focus?: DriverStoreFocus];
  openTunnelProfileSettings: [];
}>();

const store = useConnectionStore();
const tunnelProfileStore = useTunnelProfileStore();
const isTesting = ref(false);
const isSaving = ref(false);
const testResult = ref<ConnectionTestState | null>(null);
const testedConfigFingerprint = ref("");
const testedConfigId = ref("");
const testedGeneratedName = ref("");
const savedDatabaseInfo = ref<DatabaseConnectionInfo | null>(null);
const savedDatabaseInfoFingerprint = ref("");
const savedConnectionConfigFingerprint = ref("");
const showAgentInstallDialog = ref(false);
const agentInstallRunning = ref(false);
const agentInstallDriverKey = ref("");
const agentInstallLabel = ref("");
const agentInstallProgress = ref<DriverInstallProgress | null>(null);
const agentInstallError = ref("");
const showConnectionErrorDialog = ref(false);
const connectionErrorDetail = ref("");
const editingId = ref<string | null>(null);
const draftTestConnectionId = ref(uuid());
const showVisibleDatabasesDialog = ref(false);
const isLoadingVisibleDatabases = ref(false);
const visibleDatabaseNames = ref<string[]>([]);
const visibleDatabaseSelection = ref<Set<string>>(new Set());
const visibleDatabaseSearchText = ref("");
const visibleDatabaseError = ref("");
const visibleDatabaseShowSystem = ref(false);
const showProductionDatabasesDialog = ref(false);
const isLoadingProductionDatabases = ref(false);
const productionDatabaseNames = ref<string[]>([]);
const productionDatabaseSelection = ref<Set<string>>(new Set());
const productionDatabaseSearchText = ref("");
const productionDatabaseError = ref("");
const productionProtectionEnabled = ref(false);
const showVisibleSchemasDialog = ref(false);
const isLoadingVisibleSchemas = ref(false);
const visibleSchemaNames = ref<string[]>([]);
const visibleSchemaInitialSelection = ref<string[]>([]);
const visibleSchemaError = ref("");
let testRunId = 0;
let unlistenAgentInstallProgress: (() => void) | null = null;

function initialConfigTab(): ConfigTab {
  return props.initialTab ?? "connection";
}

const defaultForm = (): ConnectionForm => ({
  name: "",
  db_type: "mysql",
  driver_profile: "mysql",
  driver_label: "MySQL",
  url_params: "",
  agent_java_options: [],
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  database: undefined,
  color: "",
  transport_layers: [],
  connect_timeout_secs: 10,
  query_timeout_secs: 30,
  idle_timeout_secs: 60,
  keepalive_interval_secs: 30,
  ssl: false,
  ca_cert_path: "",
  client_cert_path: "",
  client_key_path: "",
  sysdba: false,
  oracle_connection_type: "service_name",
  connection_string: undefined,
  jdbc_driver_class: undefined,
  jdbc_driver_paths: [],
  redis_connection_mode: "standalone",
  redis_sentinel_master: "",
  redis_sentinel_nodes: "",
  redis_sentinel_username: "",
  redis_sentinel_password: "",
  redis_sentinel_tls: false,
  redis_cluster_nodes: "",
  redis_key_separator: ":",
  redis_scan_page_size: REDIS_SCAN_PAGE_SIZE_DEFAULT,
  etcd_endpoints: "",
  gbase_server: "",
  informix_server: "",
  external_config: undefined,
  init_script: undefined,
  read_only: false,
  is_production: false,
  production_databases: [],
  visible_databases: undefined,
});

const elasticsearchConnectionMode = ref<ElasticsearchConnectionMode>("direct");
const elasticsearchKibanaBasePath = ref("");
const elasticsearchConnectionPorts = ref<Record<ElasticsearchConnectionMode, number>>({
  direct: 9200,
  kibana: 5601,
});

function resetElasticsearchProxyFields(externalConfig?: unknown) {
  const mode = elasticsearchConnectionModeFromConfig(externalConfig);
  elasticsearchConnectionMode.value = mode;
  elasticsearchKibanaBasePath.value = elasticsearchKibanaBasePathFromConfig(externalConfig);
  elasticsearchConnectionPorts.value = {
    direct: mode === "direct" ? form.value.port : 9200,
    kibana: mode === "kibana" ? form.value.port : 5601,
  };
}

function switchElasticsearchConnectionMode(mode: ElasticsearchConnectionMode) {
  if (mode === elasticsearchConnectionMode.value) return;
  elasticsearchConnectionPorts.value[elasticsearchConnectionMode.value] = form.value.port;
  form.value.port = elasticsearchConnectionPorts.value[mode];
  elasticsearchConnectionMode.value = mode;
  resetTestState();
}

function defaultSshTunnel(): SshTunnelConfig {
  return {
    id: uuid(),
    name: "",
    enabled: true,
    host: "",
    port: 22,
    user: DEFAULT_SSH_USER,
    password: "",
    key_path: "",
    key_passphrase: "",
    connect_timeout_secs: 5,
    expose_lan: false,
    use_ssh_agent: false,
    ssh_agent_sock_path: "",
    auth_method: "password",
  };
}

/**
 * Infers a login method for connections saved before `auth_method` existed
 * (or imported from a source that never set it), so the dropdown shows a
 * sensible current state instead of defaulting blindly to "password".
 * Mirrors the priority `connect_and_authenticate` actually uses at connect
 * time (key > password > agent > none) — see `db/ssh_tunnel.rs`.
 */
function inferSshAuthMethod(hop: Partial<SshTunnelConfig>): "password" | "key" | "agent" | "none" {
  if (hop.key_path?.trim()) return "key";
  if (hop.password) return "password";
  if (hop.use_ssh_agent) return "agent";
  return "none";
}

function normalizeSshTunnel(hop: Partial<SshTunnelConfig>): SshTunnelConfig {
  return {
    id: hop.id || uuid(),
    name: hop.name || "",
    enabled: hop.enabled !== false,
    host: hop.host || "",
    port: Number(hop.port) || 22,
    user: hop.user?.trim() || DEFAULT_SSH_USER,
    password: hop.password || "",
    key_path: hop.key_path || "",
    key_passphrase: hop.key_passphrase || "",
    connect_timeout_secs: Number(hop.connect_timeout_secs) || 5,
    expose_lan: !!hop.expose_lan,
    use_ssh_agent: !!hop.use_ssh_agent,
    ssh_agent_sock_path: hop.ssh_agent_sock_path || "",
    auth_method: hop.auth_method || inferSshAuthMethod(hop),
    profile_id: hop.profile_id || undefined,
  };
}

function defaultProxyTunnel(): ProxyTunnelConfig {
  return {
    id: uuid(),
    name: "",
    enabled: true,
    proxy_type: "socks5",
    host: "",
    port: 1080,
    username: "",
    password: "",
  };
}

function defaultHttpTunnel(): HttpTunnelConfig {
  return {
    id: uuid(),
    name: "",
    enabled: true,
    url: "",
    token: "",
    connect_timeout_secs: 10,
  };
}

function normalizeProxyTunnel(layer: Partial<ProxyTunnelConfig>): ProxyTunnelConfig {
  return {
    id: layer.id || uuid(),
    name: layer.name || "",
    enabled: layer.enabled !== false,
    proxy_type: layer.proxy_type || "socks5",
    host: layer.host || "",
    port: Number(layer.port) || 1080,
    username: layer.username || "",
    password: layer.password || "",
    profile_id: layer.profile_id || undefined,
  };
}

function normalizeHttpTunnel(layer: Partial<HttpTunnelConfig>): HttpTunnelConfig {
  return {
    id: layer.id || uuid(),
    name: layer.name || "",
    enabled: layer.enabled !== false,
    url: layer.url || "",
    token: layer.token || "",
    connect_timeout_secs: Number(layer.connect_timeout_secs) || 10,
    profile_id: layer.profile_id || undefined,
  };
}

function normalizeTransportLayer(layer: Partial<TransportLayerConfig>): TransportLayerConfig {
  if (layer.type === "proxy") {
    return { type: "proxy", ...normalizeProxyTunnel(layer) };
  }
  if (layer.type === "http_tunnel") {
    return { type: "http_tunnel", ...normalizeHttpTunnel(layer) };
  }
  return { type: "ssh", ...normalizeSshTunnel(layer as Partial<SshTunnelConfig>) };
}

function transportLayersForConfig(config: LegacyConnectionConfig): TransportLayerConfig[] {
  if (config.transport_layers?.length) {
    return config.transport_layers.map(normalizeTransportLayer);
  }
  const layers: TransportLayerConfig[] = sshLayersForConfig(config).map((hop) => ({ type: "ssh", ...hop }));
  if (config.proxy_enabled || config.proxy_host || config.proxy_username || config.proxy_password) {
    layers.push({
      type: "proxy",
      ...normalizeProxyTunnel({
        id: "legacy-proxy",
        enabled: true,
        proxy_type: config.proxy_type || "socks5",
        host: config.proxy_host || "",
        port: config.proxy_port || 1080,
        username: config.proxy_username || "",
        password: config.proxy_password || "",
      }),
    });
  }
  return layers;
}

function sshLayersForConfig(config: LegacyConnectionConfig): SshTunnelConfig[] {
  if (config.ssh_tunnels?.length) {
    return config.ssh_tunnels.map(normalizeSshTunnel);
  }
  if (config.ssh_enabled || config.ssh_host || config.ssh_user || config.ssh_password || config.ssh_key_path || config.ssh_key_passphrase) {
    return [
      normalizeSshTunnel({
        id: "legacy",
        enabled: true,
        host: config.ssh_host || "",
        port: config.ssh_port || 22,
        user: config.ssh_user || "",
        password: config.ssh_password || "",
        key_path: config.ssh_key_path || "",
        key_passphrase: config.ssh_key_passphrase || "",
        connect_timeout_secs: config.ssh_connect_timeout_secs || 5,
        expose_lan: config.ssh_expose_lan || false,
        use_ssh_agent: false,
        ssh_agent_sock_path: "",
      }),
    ];
  }
  return [];
}

const form = ref(defaultForm());
const showJdbcDependencyDriverManagerAction = computed(() => form.value.db_type === "jdbc" && isJdbcMissingRuntimeDependencyError(connectionErrorDetail.value));

function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function sqlServerPortExplicitFromConfig(config: Pick<ConnectionConfig, "db_type" | "external_config">): boolean {
  if (config.db_type !== "sqlserver") return false;
  const external = externalConfigRecord(config.external_config);
  return external.portExplicit === true || external.port_explicit === true;
}

function setSqlServerPortExplicit(config: Pick<ConnectionConfig, "db_type"> & { external_config?: unknown }, explicit: boolean) {
  if (config.db_type !== "sqlserver") return;
  const next = externalConfigRecord(config.external_config);
  delete next.port_explicit;
  if (explicit) {
    next.portExplicit = true;
  } else {
    delete next.portExplicit;
  }
  config.external_config = Object.keys(next).length > 0 ? next : undefined;
}

function markSqlServerPortExplicit() {
  setSqlServerPortExplicit(form.value, true);
}

const keepaliveEnabled = computed({
  get: () => Number(form.value.keepalive_interval_secs) > 0,
  set: (enabled: boolean) => {
    if (enabled) {
      const current = Number(form.value.keepalive_interval_secs);
      form.value.keepalive_interval_secs = Number.isFinite(current) && current > 0 ? current : 30;
    } else {
      form.value.keepalive_interval_secs = 0;
    }
  },
});
const selectedTransportLayerId = ref<string | null>(null);
const draggedTransportLayerId = ref<string | null>(null);
const selectedType = ref("mysql");
const customDriverName = ref("");
const mongoUseUrl = ref(false);
const jdbcDriverPathsInput = ref("");
const jdbcDrivers = ref<JdbcDriverInfo[]>([]);
const jdbcMavenBundles = ref<JdbcMavenBundleInfo[]>([]);
const jdbcLocalBundles = ref<JdbcLocalBundleInfo[]>([]);
const sshConfigHosts = ref<SshConfigHostEntry[]>([]);
const agentDrivers = ref<AgentDriverInstallState[]>([]);
const selectedJdbcDriverPath = ref("");
const jdbcManualClasspathOpen = ref(false);
const connectionUrlInput = ref("");
const appliedConnectionUrlInput = ref("");
const oceanbaseSubMode = ref<"mysql" | "oracle">("mysql");
const h2ConnectionMode = ref<H2ConnectionMode>("file");
const dremioConnectionMode = ref<DremioConnectionMode>("legacy");
const dremioConnectionUrls = ref<Record<DremioConnectionMode, string>>({
  "arrow-flight-sql": DREMIO_ARROW_FLIGHT_SQL_JDBC_URL,
  legacy: DREMIO_LEGACY_JDBC_URL,
});
const hiveAuthMode = ref<HiveKerberosAuthMode>("none");
const hivePrincipal = ref("");
const hiveKrb5ConfPath = ref("");
const hiveJaasConfigPath = ref("");
const hiveUseSubjectCredsOnlyFalse = ref(false);
const hiveExtraJavaOptions = ref("");
const dialogStep = ref<DialogStep>("select");
const dbPickerView = ref<DbPickerView>("icon");
const dbSearchQuery = ref("");
const configTab = ref<ConfigTab>("connection");
const MQ_KAFKA_SECURITY_PROTOCOL_AUTO = "__auto";
const mqAdminUrl = ref("http://127.0.0.1:8080");
const mqSystemKind = ref<MqSystemKind>("pulsar");
const mqRocketmqNamesrvAddr = ref("127.0.0.1:9876");
const mqRocketmqClusterName = ref("");
const mqKafkaBootstrapServers = ref("127.0.0.1:9092");
const mqKafkaSecurityProtocol = ref(MQ_KAFKA_SECURITY_PROTOCOL_AUTO);
const mqKafkaSaslMechanism = ref("PLAIN");
const mqKafkaKerberosPrincipal = ref("");
const mqKafkaKerberosKeytabPath = ref("");
const mqKafkaKerberosServiceName = ref("kafka");
const mqKafkaKrb5ConfPath = ref("");
const mqAuthKind = ref<MqUiAuthKind>("none");
const mqToken = ref("");
const mqBasicUsername = ref("");
const mqBasicPassword = ref("");
const mqApiKeyHeader = ref("Authorization");
const mqApiKeyValue = ref("");
const mqOauthIssuerUrl = ref("");
const mqOauthClientId = ref("");
const mqOauthClientSecret = ref("");
const mqOauthAudience = ref("");
const mqOauthScope = ref("");
const mqTlsSkipVerify = ref(false);
const mqPinnedVersion = ref(pinnedVersionToSelection(undefined));
const mqTokenSigningMode = ref<MqTokenSigningMode>("none");
const mqTokenSigningKey = ref("");
const MQ_DRIVER_LABELS: Record<MqSystemKind, string> = {
  pulsar: "Apache Pulsar",
  kafka: "Apache Kafka",
  rocketmq: "Apache RocketMQ",
};

function mqSystemKindFromProfile(profile: string): MqSystemKind {
  if (profile === "kafka") return "kafka";
  if (profile === "rocketmq") return "rocketmq";
  return "pulsar";
}

function syncMqSystemKindFromSelectedType() {
  if (form.value.db_type !== "mq") return;
  mqSystemKind.value = mqSystemKindFromProfile(selectedType.value);
}

function resolveMqSystemKind(config?: Partial<MqAdminConfig>): MqSystemKind {
  if (config?.systemKind === "kafka" || config?.systemKind === "rocketmq" || config?.systemKind === "pulsar") {
    return config.systemKind;
  }
  return mqSystemKindFromProfile(selectedType.value);
}
const mqKafkaSecurityProtocolOptions = computed(() => [
  { value: MQ_KAFKA_SECURITY_PROTOCOL_AUTO, label: t("connection.mqSecurityAuto") },
  { value: "PLAINTEXT", label: "PLAINTEXT" },
  { value: "SSL", label: "SSL" },
  { value: "SASL_PLAINTEXT", label: "SASL_PLAINTEXT" },
  { value: "SASL_SSL", label: "SASL_SSL" },
]);
const mqKafkaSaslMechanismOptions = [
  { value: "PLAIN", label: "PLAIN" },
  { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
  { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512" },
];
const nacosServerAddr = ref(NACOS_DEFAULT_CONSOLE_URL);
const nacosNamespace = ref("");
const nacosContextPath = ref("");
const nacosAuthKind = ref<NacosAuthKind>("none");
const nacosUsername = ref("nacos");
const nacosPassword = ref("");
const nacosTlsSkipVerify = ref(false);
const nacosPageSize = ref(20);

const colorOptions = [
  { value: "", class: "bg-transparent border-dashed", labelKey: "connection.colorNone" },
  { value: "#22c55e", class: "bg-green-500", labelKey: "connection.colorGreen" },
  { value: "#eab308", class: "bg-yellow-500", labelKey: "connection.colorYellow" },
  { value: "#f97316", class: "bg-orange-500", labelKey: "connection.colorOrange" },
  { value: "#ef4444", class: "bg-red-500", labelKey: "connection.colorRed" },
  { value: "#3b82f6", class: "bg-blue-500", labelKey: "connection.colorBlue" },
  { value: "#a855f7", class: "bg-purple-500", labelKey: "connection.colorPurple" },
];

const isPresetColor = (color: string | undefined) => colorOptions.some((c) => c.value === (color || ""));
const customColorInput = ref("");
const customColorOpen = ref(false);

const jdbcDriverSelectItems = computed<JdbcDriverSelectItem[]>(() => {
  const localBundles = jdbcLocalBundles.value.map((bundle) => ({
    id: `local:${bundle.id}`,
    label: bundle.name,
    paths: bundle.artifacts.map((artifact) => artifact.path),
    jdbcxRuntime: bundle.artifacts.some((artifact) => isJdbcxRuntimePath(artifact.path)),
  }));
  const bundles = jdbcMavenBundles.value.map((bundle) => ({
    id: `maven:${bundle.id}`,
    label: bundle.coordinate,
    paths: bundle.artifacts.map((artifact) => artifact.path),
    jdbcxRuntime: isJdbcxRuntimeBundle(bundle),
  }));
  const manual = jdbcDrivers.value
    .filter((driver) => !driver.bundle_id)
    .map((driver) => ({
      id: `manual:${driver.path}`,
      label: driver.name,
      paths: [driver.path],
      jdbcxRuntime: isJdbcxRuntimePath(driver.path),
    }));
  return [...localBundles, ...bundles, ...manual].sort((left, right) => left.label.localeCompare(right.label));
});

const jdbcDriverSelectItemById = computed(() => new Map(jdbcDriverSelectItems.value.map((item) => [item.id, item])));
const jdbcManualClasspathCount = computed(
  () =>
    jdbcDriverPathsInput.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean).length,
);

function applyCustomColor(value: string) {
  form.value.color = value;
  customColorInput.value = value;
}

function handlePresetClick(color: string) {
  form.value.color = color;
  customColorInput.value = "";
}

function handleCustomColorPicked(value: string) {
  applyCustomColor(value);
}

function handleCustomColorInput(value: string) {
  applyCustomColor(value);
}

const driverProfiles: Record<
  string,
  {
    type: DatabaseType;
    port: number;
    user: string;
    label: string;
    icon: string;
    host?: string;
    urlParams?: string;
  }
> = {
  mysql: { type: "mysql", port: 3306, user: "root", label: "MySQL", icon: "mysql", urlParams: "" },
  postgres: {
    type: "postgres",
    port: 5432,
    user: "postgres",
    label: "PostgreSQL",
    icon: "postgres",
    urlParams: "",
  },
  redis: { type: "redis", port: 6379, user: "", label: "Redis", icon: "redis" },
  sqlite: { type: "sqlite", port: 0, user: "", label: "SQLite", icon: "sqlite" },
  rqlite: { type: "rqlite", port: 4001, user: "", label: "RQLite", icon: "rqlite" },
  turso: { type: "turso", port: 443, user: "", label: "Turso", icon: "turso" },
  "cloudflare-d1": { type: "cloudflare-d1", port: 443, user: "", label: "Cloudflare D1", icon: "cloudflare-d1" },
  duckdb: { type: "duckdb", port: 0, user: "", label: "DuckDB", icon: "duckdb" },
  access: { type: "access", port: 0, user: "", label: "Microsoft Access", icon: "access" },
  mongodb: { type: "mongodb", port: 27017, user: "", label: "MongoDB", icon: "mongodb" },
  "mongodb-legacy": { type: "mongodb", port: 27017, user: "", label: "MongoDB (Legacy)", icon: "mongodb" },
  clickhouse: {
    type: "clickhouse",
    port: 8123,
    user: "default",
    label: "ClickHouse",
    icon: "clickhouse",
  },
  sqlserver: { type: "sqlserver", port: 1433, user: "sa", label: "SQL Server", icon: "sqlserver" },
  oracle: { type: "oracle", port: 1521, user: "system", label: "Oracle", icon: "oracle" },
  elasticsearch: {
    type: "elasticsearch",
    port: 9200,
    user: "",
    label: "Elasticsearch",
    icon: "elasticsearch",
  },
  qdrant: { type: "qdrant", port: 6333, user: "", label: "Qdrant", icon: "qdrant" },
  milvus: { type: "milvus", port: 19530, user: "root", label: "Milvus", icon: "milvus" },
  weaviate: { type: "weaviate", port: 8080, user: "", label: "Weaviate", icon: "weaviate" },
  chromadb: { type: "chromadb", port: 8000, user: "", label: "ChromaDB", icon: "chromadb" },
  mariadb: { type: "mysql", port: 3306, user: "root", label: "MariaDB", icon: "mariadb" },
  tidb: { type: "mysql", port: 4000, user: "root", label: "TiDB", icon: "tidb" },
  oceanbase: { type: "mysql", port: 2883, user: "root", label: "OceanBase", icon: "oceanbase" },
  "oceanbase-oracle": {
    type: "oceanbase-oracle",
    port: 2883,
    user: "SYS",
    label: "OceanBase Oracle Mode",
    icon: "oceanbase",
  },
  goldendb: { type: "goldendb", port: 3306, user: "root", label: "GoldenDB", icon: "goldendb" },
  databend: { type: "databend", port: 8000, user: "databend", label: "Databend", icon: "databend" },
  tdsql: { type: "mysql", port: 3306, user: "root", label: "TDSQL", icon: "tdsql" },
  polardb: { type: "mysql", port: 3306, user: "root", label: "PolarDB", icon: "polardb" },
  greatsql: { type: "mysql", port: 3306, user: "root", label: "GreatSQL", icon: "greatsql" },
  databricks: { type: "databricks", port: 443, user: "token", label: "Databricks SQL", icon: "databricks" },
  saphana: { type: "saphana", port: 30015, user: "SYSTEM", label: "SAP HANA", icon: "saphana" },
  teradata: { type: "teradata", port: 1025, user: "", label: "Teradata", icon: "teradata" },
  vertica: { type: "vertica", port: 5433, user: "dbadmin", label: "Vertica", icon: "vertica" },
  firebird: { type: "firebird", port: 3050, user: "SYSDBA", label: "Firebird", icon: "firebird" },
  exasol: { type: "exasol", port: 8563, user: "sys", label: "Exasol", icon: "exasol" },
  gbase: { type: "gbase", port: 5258, user: "gbasedbt", label: "GBase 8a", icon: "gbase" },
  gbase8a: { type: "gbase", port: 5258, user: "gbasedbt", label: "GBase 8a", icon: "gbase" },
  gbase8s: { type: "gbase", port: 9088, user: "gbasedbt", label: "GBase 8s", icon: "gbase" },
  opengauss: {
    type: "opengauss",
    port: 5432,
    user: "gaussdb",
    label: "openGauss",
    icon: "opengauss",
  },
  gaussdb: { type: "gaussdb", port: 5432, user: "gaussdb", label: "GaussDB", icon: "gaussdb" },
  kwdb: { type: "kwdb", port: 26257, user: "root", label: "KWDB", icon: "kwdb" },
  questdb: { type: "questdb", port: 8812, user: "questdb", label: "QuestDB", icon: "questdb" },
  kingbase: { type: "kingbase", port: 54321, user: "system", label: "KingBase", icon: "kingbase" },
  highgo: { type: "highgo", port: 5866, user: "highgo", label: "瀚高 HighGo", icon: "highgo" },
  yashandb: { type: "yashandb", port: 1688, user: "sys", label: "崖山 YashanDB", icon: "yashandb" },
  vastbase: { type: "vastbase", port: 5432, user: "vastbase", label: "Vastbase", icon: "vastbase" },
  doris: { type: "mysql", port: 9030, user: "root", label: "Doris", icon: "doris", urlParams: "" },
  selectdb: {
    type: "mysql",
    port: 9030,
    user: "root",
    label: "SelectDB",
    icon: "selectdb",
    urlParams: "",
  },
  starrocks: {
    type: "mysql",
    port: 9030,
    user: "root",
    label: "StarRocks",
    icon: "starrocks",
    urlParams: "",
  },
  manticoresearch: {
    type: "manticoresearch",
    port: 9306,
    user: "root",
    label: "Manticore Search",
    icon: "manticoresearch",
    urlParams: "",
  },
  redshift: { type: "redshift", port: 5439, user: "awsuser", label: "Redshift", icon: "redshift" },
  cockroachdb: {
    type: "postgres",
    port: 26257,
    user: "root",
    label: "CockroachDB",
    icon: "cockroachdb",
  },
  dm: { type: "dameng", port: 5236, user: "SYSDBA", label: "达梦 Dameng", icon: "dm" },
  h2: { type: "h2", port: 9092, user: "sa", label: "H2", icon: "h2" },
  "h2-legacy": { type: "h2", port: 9092, user: "sa", label: "H2 2.1 Legacy", icon: "h2" },
  snowflake: { type: "snowflake", port: 443, user: "", label: "Snowflake", icon: "snowflake" },
  trino: { type: "trino", port: 8080, user: "", label: "Trino", icon: "trino" },
  prestosql: { type: "prestosql", port: 8080, user: "", label: "PrestoSQL", icon: "presto" },
  hive: { type: "hive", port: 10000, user: "", label: "Apache Hive", icon: "hive" },
  spark: { type: "spark", port: 10015, user: "", label: "Apache Spark", icon: "spark" },
  db2: { type: "db2", port: 50000, user: "db2inst1", label: "IBM DB2", icon: "db2" },
  informix: { type: "informix", port: 9088, user: "informix", label: "Informix", icon: "informix" },
  dremio: { type: "jdbc", port: 31010, user: "", label: "Dremio", icon: "dremio" },
  jdbcx: { type: "jdbc", port: 0, user: "", label: "JDBCX", icon: "jdbcx" },
  neo4j: { type: "neo4j", port: 7687, user: "neo4j", label: "Neo4j", icon: "neo4j" },
  cassandra: { type: "cassandra", port: 9042, user: "cassandra", label: "Cassandra", icon: "cassandra" },
  bigquery: {
    type: "bigquery",
    port: 443,
    user: "",
    label: "BigQuery",
    icon: "bigquery",
    host: "https://www.googleapis.com/bigquery/v2",
  },
  kylin: { type: "kylin", port: 7070, user: "ADMIN", label: "Apache Kylin", icon: "kylin" },
  sundb: { type: "sundb", port: 22000, user: "root", label: "SunDB", icon: "sundb" },
  oscar: { type: "oscar", port: 2003, user: "SYSDBA", label: "神通 OSCAR", icon: "oscar" },
  jdbc: { type: "jdbc", port: 0, user: "", label: "JDBC", icon: "jdbc" },
  tdengine: { type: "tdengine", port: 6041, user: "root", label: "TDengine", icon: "tdengine" },
  xugu: { type: "xugu", port: 5138, user: "", label: "虚谷 XuguDB", icon: "xugu" },
  iotdb: { type: "iotdb", port: 6667, user: "root", label: "Apache IoTDB", icon: "iotdb" },
  etcd: { type: "etcd", port: 2379, user: "", label: "etcd", icon: "etcd" },
  zookeeper: { type: "zookeeper", port: 2181, user: "", label: "Apache ZooKeeper", icon: "zookeeper" },
  mq: { type: "mq", port: 8080, user: "", label: "Apache Pulsar", icon: "pulsar", host: "127.0.0.1" },
  kafka: { type: "mq", port: 9092, user: "", label: "Apache Kafka", icon: "kafka", host: "127.0.0.1" },
  rocketmq: { type: "mq", port: 9876, user: "", label: "Apache RocketMQ", icon: "rocketmq", host: "127.0.0.1" },
  nacos: { type: "nacos", port: 8848, user: "nacos", label: "Nacos", icon: "nacos", host: "127.0.0.1" },
  iris: { type: "iris", port: 1972, user: "_SYSTEM", label: "IRIS", icon: "iris" },
  influxdb: { type: "influxdb", port: 8086, user: "", label: "InfluxDB", icon: "InfluxDB" },
  custom_mysql: {
    type: "mysql",
    port: 3306,
    user: "root",
    label: "Custom",
    icon: "mysql",
    urlParams: "",
  },
  custom_postgres: {
    type: "postgres",
    port: 5432,
    user: "postgres",
    label: "Custom",
    icon: "postgres",
    urlParams: "",
  },
};

function profileForConfig(config: ConnectionConfig) {
  if (config.db_type === "oracle") return "oracle";
  if (config.driver_profile && driverProfiles[config.driver_profile]) {
    if (config.driver_profile === "oceanbase-oracle") return "oceanbase";
    return config.driver_profile;
  }
  if (config.db_type === "mq") {
    const kind = (config.external_config as MqAdminConfig | undefined)?.systemKind;
    if (kind === "kafka") return "kafka";
    if (kind === "rocketmq") return "rocketmq";
    return "mq";
  }
  if (config.db_type === "dameng") return "dm";
  if (config.db_type === "oceanbase-oracle") return "oceanbase";
  return config.db_type;
}

function selectedProfile() {
  return driverProfiles[selectedType.value] ?? driverProfiles.mysql;
}

function mqExtraRecord(config?: Partial<MqAdminConfig>): Record<string, unknown> {
  const extra = config?.extra;
  return extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
}

function mqExtraString(extra: Record<string, unknown>, key: string): string {
  const value = extra[key];
  return typeof value === "string" ? value : "";
}

function mqExtraProperties(extra: Record<string, unknown>): Record<string, unknown> {
  const value = extra.properties;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mqExtraPropertyString(extra: Record<string, unknown>, key: string): string {
  const value = mqExtraProperties(extra)[key];
  return typeof value === "string" ? value : "";
}

function jaasStringValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseJaasStringProperty(value: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`${escapedKey}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "i"));
  if (!match) return "";
  return match[1].replace(/\\(["\\])/g, "$1");
}

function resetMqFields(config?: Partial<MqAdminConfig>) {
  const systemKind = resolveMqSystemKind(config);
  const extra = mqExtraRecord(config);
  const properties = mqExtraProperties(extra);
  const jaasConfig = mqExtraPropertyString(extra, "sasl.jaas.config");
  mqSystemKind.value = systemKind;
  mqAdminUrl.value = config?.adminUrl?.trim() || (systemKind === "kafka" || systemKind === "rocketmq" ? "" : "http://127.0.0.1:8080");
  mqKafkaBootstrapServers.value = mqExtraString(extra, "bootstrapServers") || "127.0.0.1:9092";
  mqRocketmqNamesrvAddr.value = mqExtraString(extra, "namesrvAddr") || mqExtraString(extra, "namesrv_addr") || "127.0.0.1:9876";
  mqRocketmqClusterName.value = mqExtraString(extra, "clusterName") || mqExtraString(extra, "cluster_name");
  mqKafkaSecurityProtocol.value = mqExtraString(extra, "securityProtocol") || MQ_KAFKA_SECURITY_PROTOCOL_AUTO;
  mqKafkaSaslMechanism.value = mqExtraString(extra, "saslMechanism") || "PLAIN";
  mqKafkaKerberosPrincipal.value = parseJaasStringProperty(jaasConfig, "principal");
  mqKafkaKerberosKeytabPath.value = parseJaasStringProperty(jaasConfig, "keyTab");
  mqKafkaKerberosServiceName.value = typeof properties["sasl.kerberos.service.name"] === "string" ? properties["sasl.kerberos.service.name"] : "kafka";
  mqKafkaKrb5ConfPath.value = typeof properties["java.security.krb5.conf"] === "string" ? properties["java.security.krb5.conf"] : "";
  mqTlsSkipVerify.value = !!config?.tlsSkipVerify;
  mqPinnedVersion.value = pinnedVersionToSelection(config?.pinnedVersion);
  const auth = (config?.auth || { kind: "none" }) as MqAuth;
  mqAuthKind.value = detectMqUiAuthKind({
    systemKind,
    authKind: auth.kind,
    saslMechanism: mqKafkaSaslMechanism.value,
    jaasConfig,
  });
  mqToken.value = auth.token || "";
  mqBasicUsername.value = auth.username || "";
  mqBasicPassword.value = auth.password || "";
  mqApiKeyHeader.value = auth.header || "Authorization";
  mqApiKeyValue.value = auth.value || "";
  mqOauthIssuerUrl.value = auth.issuerUrl || "";
  mqOauthClientId.value = auth.clientId || "";
  mqOauthClientSecret.value = auth.clientSecret || "";
  mqOauthAudience.value = auth.audience || "";
  mqOauthScope.value = auth.scope || "";
  const tokenSigning = config?.tokenSigning;
  mqTokenSigningMode.value = tokenSigning?.algorithm === "hs256" || tokenSigning?.algorithm === "rs256" ? tokenSigning.algorithm : "none";
  mqTokenSigningKey.value = tokenSigning?.key || "";
}

function defaultMqFieldsForProfile(profile: string): Partial<MqAdminConfig> | undefined {
  if (profile === "kafka") {
    return {
      systemKind: "kafka",
      adminUrl: "",
      auth: { kind: "none" },
      extra: { bootstrapServers: "127.0.0.1:9092" },
    };
  }
  if (profile === "rocketmq") {
    return {
      systemKind: "rocketmq",
      adminUrl: "",
      auth: { kind: "none" },
      extra: { namesrvAddr: "127.0.0.1:9876" },
    };
  }
  return undefined;
}

function hydrateMqFields(value: unknown) {
  if (!value || typeof value !== "object") {
    resetMqFields();
    return;
  }
  resetMqFields(value as Partial<MqAdminConfig>);
}

watch(selectedType, () => {
  syncMqSystemKindFromSelectedType();
});

watch(mqSystemKind, (kind) => {
  if (kind === "kafka") {
    if (!mqKafkaBootstrapServers.value.trim()) mqKafkaBootstrapServers.value = "127.0.0.1:9092";
    if (!isMqAuthKindAllowedForSystem(kind, mqAuthKind.value)) mqAuthKind.value = "none";
    return;
  }
  if (kind === "rocketmq") {
    if (!mqRocketmqNamesrvAddr.value.trim()) mqRocketmqNamesrvAddr.value = "127.0.0.1:9876";
    if (!isMqAuthKindAllowedForSystem(kind, mqAuthKind.value)) mqAuthKind.value = "none";
    return;
  }
  if (!mqAdminUrl.value.trim()) mqAdminUrl.value = "http://127.0.0.1:8080";
});

watch(mqAuthKind, (kind) => {
  if (mqSystemKind.value === "kafka" && kind === "basic" && mqKafkaSaslMechanism.value.toUpperCase() === "GSSAPI") {
    mqKafkaSaslMechanism.value = "PLAIN";
  }
});

function resetNacosFields(config?: Partial<NacosAdminConfig>) {
  nacosServerAddr.value = config?.serverAddr?.trim() || NACOS_DEFAULT_CONSOLE_URL;
  nacosNamespace.value = config?.namespace || "";
  nacosContextPath.value = config?.contextPath || "";
  nacosTlsSkipVerify.value = !!config?.tlsSkipVerify;
  nacosPageSize.value = Number(config?.pageSize) > 0 ? Number(config?.pageSize) : 20;
  const auth = (config?.auth || { kind: "none" }) as NacosAuthConfig;
  nacosAuthKind.value = auth.kind || "none";
  nacosUsername.value = auth.username || "nacos";
  nacosPassword.value = auth.password || "";
}

function hydrateNacosFields(value: unknown) {
  if (!value || typeof value !== "object") {
    resetNacosFields();
    return;
  }
  resetNacosFields(value as Partial<NacosAdminConfig>);
}

const influxDbVersion = ref<InfluxDbVersion>("1");
const influxDbOrg = ref("");

function resetInfluxDbFields(config?: Partial<InfluxDbExternalConfig>) {
  influxDbVersion.value = config?.version === "2" ? "2" : "1";
  influxDbOrg.value = config?.org?.trim() || "";
}

function hydrateInfluxDbFields(value: unknown) {
  if (!value || typeof value !== "object") {
    resetInfluxDbFields();
    return;
  }
  resetInfluxDbFields(value as Partial<InfluxDbExternalConfig>);
}

function resetHiveKerberosFields(config?: Pick<ConnectionConfig, "url_params" | "agent_java_options">) {
  const kerberos = hiveKerberosFormConfig(config?.url_params, config?.agent_java_options);
  hiveAuthMode.value = kerberos.authMode;
  hivePrincipal.value = kerberos.principal;
  hiveKrb5ConfPath.value = kerberos.krb5ConfPath;
  hiveJaasConfigPath.value = kerberos.jaasConfigPath;
  hiveUseSubjectCredsOnlyFalse.value = kerberos.useSubjectCredsOnlyFalse;
  hiveExtraJavaOptions.value = kerberos.extraJavaOptions;
}

function buildInfluxDbExternalConfig(): InfluxDbExternalConfig {
  if (influxDbVersion.value !== "2") return { version: "1" };
  const org = influxDbOrg.value.trim();
  if (!org) throw new Error("InfluxDB 2.x organization is required");
  if (!form.value.password.trim()) throw new Error("InfluxDB 2.x token is required");
  if (!form.value.database?.trim()) throw new Error("InfluxDB 2.x bucket is required");
  return { version: "2", org };
}

watch(influxDbVersion, (version) => {
  if (form.value.db_type !== "influxdb") return;
  if (version === "2") {
    form.value.username = "";
  }
});

function requireMqField(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function buildMqAuth(): MqAuth {
  switch (mqAuthKind.value) {
    case "token":
      return { kind: "token", token: requireMqField(mqToken.value, "Token auth requires a token") };
    case "basic":
      return {
        kind: "basic",
        username: requireMqField(mqBasicUsername.value, "Basic auth requires a username"),
        password: mqBasicPassword.value,
      };
    case "apiKey":
      return {
        kind: "apiKey",
        header: requireMqField(mqApiKeyHeader.value, "API key auth requires a header"),
        value: requireMqField(mqApiKeyValue.value, "API key auth requires a value"),
      };
    case "oauth2":
      return {
        kind: "oauth2",
        issuerUrl: requireMqField(mqOauthIssuerUrl.value, t("connection.mqOauthIssuerRequired")),
        clientId: requireMqField(mqOauthClientId.value, t("connection.mqOauthClientIdRequired")),
        clientSecret: requireMqField(mqOauthClientSecret.value, t("connection.mqOauthClientSecretRequired")),
        audience: mqOauthAudience.value.trim() || undefined,
        scope: mqOauthScope.value.trim() || undefined,
      };
    default:
      return { kind: "none" };
  }
}

function buildKafkaKerberosJaasConfig(): string {
  const principal = requireMqField(mqKafkaKerberosPrincipal.value, t("connection.kafkaKerberosPrincipalRequired"));
  const keytab = requireMqField(mqKafkaKerberosKeytabPath.value, t("connection.kafkaKerberosKeytabRequired"));
  return `com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true storeKey=true keyTab="${jaasStringValue(keytab)}" principal="${jaasStringValue(principal)}";`;
}

function buildMqTokenSigning() {
  if (mqTokenSigningMode.value === "none") return undefined;
  return {
    algorithm: mqTokenSigningMode.value,
    key: requireMqField(mqTokenSigningKey.value, t("connection.mqTokenSigningKeyRequired")),
  };
}

function buildMqAdminConfig(): MqAdminConfig {
  const systemKind = mqSystemKind.value;
  if (systemKind === "kafka") {
    const bootstrapServers = normalizeKafkaBootstrapServers(mqKafkaBootstrapServers.value);
    const extra: Record<string, unknown> = { bootstrapServers };
    const securityProtocol = mqKafkaSecurityProtocol.value === MQ_KAFKA_SECURITY_PROTOCOL_AUTO ? "" : mqKafkaSecurityProtocol.value.trim();
    const saslMechanism = mqAuthKind.value === "kerberos" ? "GSSAPI" : mqKafkaSaslMechanism.value.trim();
    const properties: Record<string, string> = {};
    if (securityProtocol) extra.securityProtocol = securityProtocol;
    if (mqAuthKind.value === "basic" && saslMechanism) extra.saslMechanism = saslMechanism;
    if (mqAuthKind.value === "kerberos") {
      extra.saslMechanism = "GSSAPI";
      properties["sasl.jaas.config"] = buildKafkaKerberosJaasConfig();
      properties["sasl.kerberos.service.name"] = mqKafkaKerberosServiceName.value.trim() || "kafka";
      if (mqKafkaKrb5ConfPath.value.trim()) {
        properties["java.security.krb5.conf"] = mqKafkaKrb5ConfPath.value.trim();
      }
    }
    if (Object.keys(properties).length) extra.properties = properties;
    return {
      systemKind: mqSystemKind.value,
      adminUrl: "",
      auth: buildMqAuth(),
      tlsSkipVerify: mqTlsSkipVerify.value || undefined,
      extra,
    };
  }

  if (systemKind === "rocketmq") {
    const namesrvAddr = normalizeRocketmqNamesrvAddr(mqRocketmqNamesrvAddr.value);
    const extra: Record<string, unknown> = { namesrvAddr };
    if (mqRocketmqClusterName.value.trim()) extra.clusterName = mqRocketmqClusterName.value.trim();
    if (mqAuthKind.value === "basic") {
      extra.accessKey = mqBasicUsername.value.trim();
      extra.secretKey = mqBasicPassword.value;
    }
    return {
      systemKind: "rocketmq",
      adminUrl: "",
      auth: buildMqAuth(),
      tlsSkipVerify: mqTlsSkipVerify.value || undefined,
      extra,
    };
  }

  return {
    systemKind: mqSystemKind.value,
    adminUrl: requireMqField(mqAdminUrl.value, t("connection.mqAdminUrlRequired")),
    auth: buildMqAuth(),
    tlsSkipVerify: mqTlsSkipVerify.value || undefined,
    pinnedVersion: selectionToPinnedVersion(mqPinnedVersion.value),
    tokenSigning: buildMqTokenSigning(),
  };
}

function buildNacosAuth(): NacosAuthConfig {
  if (nacosAuthKind.value === "usernamePassword") {
    return {
      kind: "usernamePassword",
      username: requireMqField(nacosUsername.value, t("connection.nacosUsernameRequired")),
      password: nacosPassword.value,
    };
  }
  return { kind: "none" };
}

function buildNacosAdminConfig(): NacosAdminConfig {
  return {
    serverAddr: requireMqField(nacosServerAddr.value, t("connection.nacosConsoleUrlRequired")),
    namespace: nacosNamespace.value.trim() || undefined,
    contextPath: nacosContextPath.value.trim(),
    auth: buildNacosAuth(),
    tlsSkipVerify: nacosTlsSkipVerify.value || undefined,
    pageSize: Number(nacosPageSize.value) > 0 ? Number(nacosPageSize.value) : 20,
  };
}

function dockerNacosConsoleFallbackUrl(serverAddr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverAddr);
  } catch {
    return null;
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const host = parsed.hostname.toLowerCase();
  if (port !== NACOS_LEGACY_SERVER_PORT || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    return null;
  }
  parsed.port = NACOS_DOCKER_CONSOLE_PORT;
  return parsed.toString().replace(/\/$/, "");
}

function isNacosAdminEndpointNotFound(message: string): boolean {
  return /Nacos admin endpoint was not found/i.test(message);
}

async function tryNacosDockerConsoleFallback(config: ConnectionConfig, originalError: string, runId: number): Promise<SuccessfulConnectionTest | null> {
  if (config.db_type !== "nacos" || !isNacosAdminEndpointNotFound(originalError)) return null;
  const fallbackUrl = dockerNacosConsoleFallbackUrl(nacosServerAddr.value);
  if (!fallbackUrl || fallbackUrl === nacosServerAddr.value.trim()) return null;

  const previousUrl = nacosServerAddr.value;
  nacosServerAddr.value = fallbackUrl;
  try {
    const fallbackConfig = connectionConfigForSubmit(config.id, config.name);
    const result = await testConnectionWithTimeout(fallbackConfig, runId);
    return {
      config: fallbackConfig,
      result: {
        ...result,
        message: `${result.message} ${t("connection.nacosConsoleUrlAutoAdjusted", { from: previousUrl.trim(), to: fallbackUrl })}`,
      },
    };
  } catch {
    nacosServerAddr.value = previousUrl;
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function connectionErrorWithDriverUpdateHint(config: ConnectionConfig, message: string): string {
  message = appendConnectionErrorHints(config, message, t);
  if (!hasAgentDriverUpdate(config.db_type, agentDrivers.value, config.driver_profile)) return message;
  return appendAgentDriverUpdateHint(message, t("connection.agentDriverUpdateConnectionHint"));
}

function installedAgentDriver(drivers: readonly AgentDriverInstallState[], key: string): AgentDriverInstallState | undefined {
  return drivers.find((driver) => driver.db_type === key);
}

async function refreshLocalAgentDrivers(): Promise<AgentDriverInstallState[]> {
  const drivers = await api.listInstalledAgentsLocal();
  agentDrivers.value = drivers;
  return drivers;
}

function beginAgentDriverInstall(driverKey: string, label: string) {
  agentInstallDriverKey.value = driverKey;
  agentInstallLabel.value = label;
  agentInstallProgress.value = null;
  agentInstallError.value = "";
  agentInstallRunning.value = true;
  showAgentInstallDialog.value = true;
}

function finishAgentDriverInstall() {
  agentInstallRunning.value = false;
  agentInstallProgress.value = null;
  agentInstallError.value = "";
  showAgentInstallDialog.value = false;
}

function failAgentDriverInstall(error: unknown) {
  agentInstallRunning.value = false;
  agentInstallError.value = errorMessage(error);
  showAgentInstallDialog.value = true;
}

function showConnectionError(message: string) {
  connectionErrorDetail.value = translateBackendError(t, message);
  showConnectionErrorDialog.value = true;
}

function setAgentInstallDialogOpen(value: boolean) {
  if (value || canCloseAgentInstallDialog.value) {
    showAgentInstallDialog.value = value;
  }
}

function handleAgentInstallProgress(payload: DriverInstallProgress) {
  if (!agentInstallRunning.value || !agentInstallDriverKey.value) return;
  if (payload.db_type && payload.db_type !== agentInstallDriverKey.value) return;
  if (payload.step === "done" || payload.step === "all-done") {
    agentInstallProgress.value = null;
    return;
  }
  agentInstallProgress.value = payload;
}

function formatInstallSize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function ensureRequiredAgentDriverInstalled(config: ConnectionConfig): Promise<void> {
  if (requiresSqlServerLegacyCompatibilityComponent(config)) {
    await installSqlServerLegacyCompatibilityComponentIfNeeded();
  }

  const driverKey = agentDriverInstallKey(config.db_type, config.driver_profile);
  if (!driverKey) return;

  let drivers = agentDrivers.value.length ? agentDrivers.value : await refreshLocalAgentDrivers();
  if (!showAgentDriverInstallHint(config.db_type, drivers, config.driver_profile)) return;
  if (installedAgentDriver(drivers, driverKey)?.installed === true) return;

  drivers = await refreshLocalAgentDrivers();
  if (installedAgentDriver(drivers, driverKey)?.installed === true) return;

  const label = config.driver_label || driverKey;
  testResult.value = { ok: true, message: `Installing ${label} driver...` };
  beginAgentDriverInstall(driverKey, label);
  try {
    await api.installAgent(driverKey);
    await refreshLocalAgentDrivers();
    finishAgentDriverInstall();
  } catch (error) {
    testResult.value = { ok: false, message: errorMessage(error) };
    failAgentDriverInstall(error);
    throw error;
  }
}

async function ensureRequiredJdbcxDriverInstalled(config: ConnectionConfig): Promise<void> {
  const result = await ensureJdbcxRuntimeDrivers(config, api, () => {
    testResult.value = { ok: true, message: "Installing JDBC plugin..." };
  });
  if (!result) return;

  jdbcMavenBundles.value = result.bundles;
  addJdbcDriverPaths(result.paths);
  form.value.jdbc_driver_paths = [...(config.jdbc_driver_paths ?? [])];
  selectedJdbcDriverPath.value = result.runtimeSelectionId;
  if (result.paths.length > 0) {
    jdbcManualClasspathOpen.value = false;
  }
}

async function installSqlServerLegacyCompatibilityComponentIfNeeded(): Promise<boolean> {
  if (await api.isAgentInstalled(SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY)) return true;

  const label = t("connection.sqlServerLegacyCompatibilityComponent");
  beginAgentDriverInstall(SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY, label);
  try {
    await api.installAgent(SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY);
    await refreshLocalAgentDrivers();
    finishAgentDriverInstall();
  } catch (error) {
    testResult.value = { ok: false, message: errorMessage(error) };
    failAgentDriverInstall(error);
    throw error;
  }
  return true;
}

async function onSqlServerLegacyCompatibilityModeChange(event: Event) {
  if (form.value.db_type !== "sqlserver") return;
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const enabled = input?.checked === true;
  // The connection test may still be using the previous compatibility mode.
  resetTestState();
  if (!enabled) {
    form.value.url_params = setSqlServerLegacyCompatibilityMode(form.value.url_params, false);
    return;
  }

  if (input) input.checked = false;
  try {
    await installSqlServerLegacyCompatibilityComponentIfNeeded();
    form.value.url_params = setSqlServerLegacyCompatibilityMode(form.value.url_params, true);
    testResult.value = null;
  } catch {
    form.value.url_params = setSqlServerLegacyCompatibilityMode(form.value.url_params, false);
    if (input) input.checked = false;
  }
}

function isSqlServerTlsHandshakeFailure(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("sql server") && text.includes("tls") && (text.includes("handshake") || text.includes("eof") || text.includes("performing i/o"));
}

function clearTestedConnectionInfo() {
  testedConfigFingerprint.value = "";
  testedConfigId.value = "";
  testedGeneratedName.value = "";
}

function clearSavedDatabaseInfo() {
  savedDatabaseInfo.value = null;
  savedDatabaseInfoFingerprint.value = "";
  savedConnectionConfigFingerprint.value = "";
}

function applySavedDatabaseInfo(config: ConnectionConfig) {
  clearSavedDatabaseInfo();
  try {
    const current = connectionConfigForSubmit(config.id, config.name);
    savedConnectionConfigFingerprint.value = connectionConfigFingerprint(current, form.value.name);
    const info = normalizeDatabaseConnectionInfo(config.database_info);
    if (info) {
      savedDatabaseInfo.value = info;
      savedDatabaseInfoFingerprint.value = savedConnectionConfigFingerprint.value;
    }
  } catch {
    clearSavedDatabaseInfo();
  }
}

function applySuccessfulConnectionTest(result: ConnectionTestResult, config: ConnectionConfig, sourceName: string) {
  testResult.value = { ok: true, ...result };
  testedConfigFingerprint.value = connectionConfigFingerprint(config, sourceName);
  testedConfigId.value = config.id;
  testedGeneratedName.value = config.name;
}

async function persistSuccessfulConnectionTest(result: ConnectionTestResult, config: ConnectionConfig, sourceName: string, runId: number) {
  if (!editingId.value || !result.databaseInfo || !savedConnectionConfigFingerprint.value) return;
  const fingerprint = connectionConfigFingerprint(config, sourceName);
  let currentDraftFingerprint: string;
  try {
    const currentDraft = connectionConfigForSubmit(editingId.value, form.value.name);
    currentDraftFingerprint = connectionConfigFingerprint(currentDraft, form.value.name);
  } catch {
    return;
  }
  // An in-flight test must not publish its saved snapshot after the user edits,
  // switches, or closes the draft that initiated it.
  if (
    !canPersistConnectionTestResult({
      testConfigId: config.id,
      activeDraftId: editingId.value,
      testRunId: runId,
      activeTestRunId: testRunId,
      submittedFingerprint: fingerprint,
      savedFingerprint: savedConnectionConfigFingerprint.value,
      currentDraftFingerprint,
    })
  ) {
    return;
  }
  const persistedDraftId = editingId.value;
  try {
    await store.updateConnectionDatabaseInfo(persistedDraftId, result.databaseInfo);
    if (runId !== testRunId || editingId.value !== persistedDraftId) return;
    savedDatabaseInfo.value = { ...result.databaseInfo };
    savedDatabaseInfoFingerprint.value = fingerprint;
  } catch {
    // The successful test remains valid even when optional metadata persistence fails.
  }
}

async function testConnectionWithTimeout(config: ConnectionConfig, runId: number): Promise<ConnectionTestResult> {
  const timeoutMs = connectionAttemptTimeoutMs(config);
  const timeoutMessage = connectionAttemptTimeoutMessage(timeoutMs);
  const promise = api.testConnectionWithInfo(config);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void promise.catch((error) => {
    if (!timedOut) return;
    if (runId !== testRunId) return;
    clearTestedConnectionInfo();
    testResult.value = {
      ok: false,
      message: connectionErrorWithDriverUpdateHint(config, connectionAttemptOriginalErrorMessage(timeoutMessage, errorMessage(error))),
    };
  });
  try {
    return await Promise.race([
      promise,
      new Promise<ConnectionTestResult>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function applyMqRocketmqNamesrv(config: LegacyConnectionConfig, namesrvAddr: string) {
  const first = normalizeRocketmqNamesrvAddr(namesrvAddr).split(";")[0];
  if (!first) throw new Error(t("connection.rocketmqNamesrvAddrRequired"));
  let parsed: URL;
  try {
    parsed = new URL(`rocketmq://${first}`);
  } catch {
    throw new Error(t("connection.rocketmqNamesrvAddrInvalid"));
  }
  config.host = parsed.hostname;
  config.port = Number(parsed.port) || 9876;
  config.ssl = false;
}

function applyMqAdminUrl(config: LegacyConnectionConfig, adminUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error(t("connection.mqAdminUrlInvalid"));
  }
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 8080);
  config.host = parsed.hostname;
  config.port = port;
  config.ssl = parsed.protocol === "https:";
}

function applyMqKafkaBootstrapServers(config: LegacyConnectionConfig, bootstrapServers: string, securityProtocol?: string) {
  const first = normalizeKafkaBootstrapServers(bootstrapServers).split(",")[0];
  if (!first) throw new Error(t("connection.mqBootstrapServersRequired"));
  let parsed: URL;
  try {
    parsed = new URL(`kafka://${first}`);
  } catch {
    throw new Error(t("connection.mqBootstrapServersInvalid"));
  }
  config.host = parsed.hostname;
  config.port = Number(parsed.port) || 9092;
  config.ssl = securityProtocol === "SSL" || securityProtocol === "SASL_SSL";
}

function applyNacosServerAddr(config: LegacyConnectionConfig, serverAddr: string) {
  let parsed: URL;
  try {
    parsed = new URL(serverAddr);
  } catch {
    throw new Error("Nacos server address is invalid");
  }
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 8848);
  config.host = parsed.hostname;
  config.port = port;
  config.ssl = parsed.protocol === "https:";
}

function applyDremioConnectionMode(mode: DremioConnectionMode) {
  rememberCurrentDremioConnectionUrl();
  dremioConnectionMode.value = mode;
  form.value.connection_string = dremioConnectionUrls.value[mode] || dremioDefaultConnectionUrl(mode);
  if (isDremioGeneratedDefaultDriverClass(form.value.jdbc_driver_class)) {
    form.value.jdbc_driver_class = dremioDefaultDriverClass(mode);
  }
}

function rememberCurrentDremioConnectionUrl() {
  if (form.value.driver_profile !== "dremio") return;
  const url = form.value.connection_string?.trim();
  dremioConnectionUrls.value[dremioConnectionMode.value] = url || dremioDefaultConnectionUrl();
}

function resetDremioConnectionUrls(mode: DremioConnectionMode = "legacy", url?: string) {
  dremioConnectionUrls.value = {
    "arrow-flight-sql": DREMIO_ARROW_FLIGHT_SQL_JDBC_URL,
    legacy: DREMIO_LEGACY_JDBC_URL,
  };
  if (url?.trim()) {
    dremioConnectionUrls.value[mode] = url.trim();
  }
}

function dremioDefaultConnectionUrl(mode = dremioConnectionMode.value) {
  return mode === "legacy" ? DREMIO_LEGACY_JDBC_URL : DREMIO_ARROW_FLIGHT_SQL_JDBC_URL;
}

function dremioDefaultDriverClass(mode = dremioConnectionMode.value) {
  return mode === "legacy" ? DREMIO_LEGACY_JDBC_DRIVER_CLASS : DREMIO_ARROW_FLIGHT_SQL_JDBC_DRIVER_CLASS;
}

function isDremioGeneratedDefaultDriverClass(value: string | undefined) {
  const driverClass = value?.trim() || "";
  return !driverClass || driverClass === DREMIO_ARROW_FLIGHT_SQL_JDBC_DRIVER_CLASS || driverClass === DREMIO_LEGACY_JDBC_DRIVER_CLASS;
}

function restoreDremioConnectionDefaultsIfEmpty() {
  if (form.value.driver_profile !== "dremio") return;
  if (!form.value.connection_string?.trim()) {
    form.value.connection_string = dremioDefaultConnectionUrl();
  }
  if (isDremioGeneratedDefaultDriverClass(form.value.jdbc_driver_class)) {
    form.value.jdbc_driver_class = dremioDefaultDriverClass();
  }
}

function syncDremioConnectionModeFromUrl() {
  if (form.value.driver_profile !== "dremio") return;
  restoreDremioConnectionDefaultsIfEmpty();
  const nextMode = dremioConnectionModeForConfig({
    connection_string: form.value.connection_string,
    jdbc_driver_class: "",
  });
  dremioConnectionUrls.value[nextMode] = form.value.connection_string?.trim() || dremioDefaultConnectionUrl(nextMode);
  if (nextMode === dremioConnectionMode.value) return;
  dremioConnectionMode.value = nextMode;
  if (isDremioGeneratedDefaultDriverClass(form.value.jdbc_driver_class)) {
    form.value.jdbc_driver_class = dremioDefaultDriverClass(nextMode);
  }
}

function dremioConnectionModeForConfig(config: Pick<ConnectionConfig, "connection_string" | "jdbc_driver_class">): DremioConnectionMode {
  const haystack = `${config.connection_string || ""}\n${config.jdbc_driver_class || ""}`.toLowerCase();
  return haystack.includes("jdbc:dremio:") || haystack.includes("com.dremio.jdbc.driver") ? "legacy" : "arrow-flight-sql";
}

function isCustomCompatibleProfile() {
  return selectedType.value === "custom_mysql" || selectedType.value === "custom_postgres";
}

function applyProfile(val: string, preserveConnectionFields = false) {
  const profile = driverProfiles[val];
  if (!profile) return;

  const previousDatabaseType = form.value.db_type;
  selectedType.value = val;
  form.value.db_type = profile.type;
  form.value.driver_profile = val;
  form.value.driver_label = isCustomCompatibleProfile() ? customDriverName.value.trim() || profile.label : profile.label;
  if (profile.type !== "sqlserver") {
    form.value.external_config = undefined;
  }
  if (profile.type !== "elasticsearch" || previousDatabaseType !== "elasticsearch") {
    resetElasticsearchProxyFields();
  }

  if (!preserveConnectionFields) {
    form.value.port = profile.port;
    setSqlServerPortExplicit(form.value, false);
    form.value.username = profile.user;
    form.value.url_params = profile.urlParams || "";
    form.value.agent_java_options = [];
    if (profile.host) {
      form.value.host = profile.host;
    }
    if (profile.type === "sqlite" || profile.type === "duckdb" || profile.type === "access") {
      form.value.host = "";
    }
    if (profile.type === "h2") {
      h2ConnectionMode.value = "file";
      form.value.host = "";
      form.value.port = 0;
      form.value.connection_string = undefined;
    }
    if (profile.type === "jdbc") {
      form.value.host = "";
      form.value.connection_string = "";
      form.value.jdbc_driver_class = "";
      form.value.jdbc_driver_paths = [];
      jdbcDriverPathsInput.value = "";
      if (val === "dremio") {
        resetDremioConnectionUrls();
        applyDremioConnectionMode("legacy");
      } else if (val === JDBCX_DRIVER_PROFILE) {
        form.value.connection_string = JDBCX_DEFAULT_URL;
        form.value.jdbc_driver_class = JDBCX_JDBC_DRIVER_CLASS;
      }
    }
    if (profile.type === "prestosql") {
      form.value.connection_string = undefined;
      form.value.jdbc_driver_class = "io.prestosql.jdbc.PrestoDriver";
      form.value.jdbc_driver_paths = [];
      jdbcDriverPathsInput.value = "";
      jdbcManualClasspathOpen.value = true;
      applyPrestoSqlBuiltinDriverPathsIfAvailable();
    }
    if (profile.type === "mq") {
      resetMqFields(defaultMqFieldsForProfile(val));
      syncMqSystemKindFromSelectedType();
      form.value.database = undefined;
      form.value.connection_string = undefined;
    }
    if (profile.type === "zookeeper") {
      form.value.database = undefined;
      form.value.connection_string = "";
      form.value.ssl = false;
      form.value.ca_cert_path = "";
      form.value.client_cert_path = "";
      form.value.client_key_path = "";
    }
    if (profile.type === "nacos") {
      resetNacosFields();
      form.value.database = undefined;
      form.value.connection_string = undefined;
      form.value.url_params = "";
    }
    if (profile.type === "influxdb") {
      resetInfluxDbFields();
      form.value.database = undefined;
      form.value.password = "";
      form.value.connection_string = undefined;
    }
    resetHiveKerberosFields(profile.type === "hive" ? form.value : undefined);
  }
}

function switchOceanbaseMode(mode: "mysql" | "oracle") {
  oceanbaseSubMode.value = mode;
  if (mode === "mysql") {
    applyProfile("oceanbase", false);
  } else {
    applyProfile("oceanbase-oracle", false);
    selectedType.value = "oceanbase";
  }
  resetTestState();
}

function switchGbaseProfile(profile: "gbase8a" | "gbase8s") {
  applyProfile(profile, false);
  selectedType.value = "gbase";
  resetTestState();
}

watch(
  [() => props.editConfig, open],
  ([config, isOpen]) => {
    const syncAction = connectionEditDraftSyncAction(config?.id ?? null, isOpen, editingId.value);
    if (syncAction === "preserve") return;
    if (syncAction === "hydrate" && config) {
      clearSavedDatabaseInfo();
      const legacyConfig = config as LegacyConnectionConfig;
      const profile = profileForConfig(config);
      const oceanbaseMode = profile === "oceanbase" ? oceanbaseSubModeFromConfig(config) : "mysql";
      const oceanbasePatch = profile === "oceanbase" ? oceanbaseModeConnectionPatch(oceanbaseMode) : null;
      editingId.value = config.id;
      const profileConfig = driverProfiles[profile];
      form.value = {
        name: config.name,
        db_type: oceanbasePatch?.db_type || profileConfig?.type || config.db_type,
        driver_profile: oceanbasePatch?.driver_profile || profile,
        driver_label: config.driver_label || oceanbasePatch?.driver_label || driverProfiles[profile]?.label || config.db_type,
        url_params: config.url_params || "",
        agent_java_options: config.agent_java_options || [],
        host: config.db_type === "h2" && h2FilePathFromJdbcUrl(config.connection_string) ? h2FilePathFromJdbcUrl(config.connection_string) : config.host,
        port: profile === "tdengine" && (config.port === 0 || config.port === 6030) ? 6041 : config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        color: config.color || "",
        transport_layers: transportLayersForConfig(legacyConfig),
        connect_timeout_secs: config.connect_timeout_secs || 10,
        query_timeout_secs: config.query_timeout_secs ?? 30,
        idle_timeout_secs: config.idle_timeout_secs ?? 60,
        keepalive_interval_secs: config.keepalive_interval_secs ?? 30,
        ssl: config.ssl || false,
        ca_cert_path: config.ca_cert_path || "",
        client_cert_path: config.client_cert_path || "",
        client_key_path: config.client_key_path || "",
        sysdba: config.sysdba || isOracleSysUser(config),
        oracle_connection_type: config.oracle_connection_type || "service_name",
        connection_string: config.connection_string,
        jdbc_driver_class: config.jdbc_driver_class,
        jdbc_driver_paths: config.jdbc_driver_paths || [],
        redis_connection_mode: config.redis_connection_mode || "standalone",
        redis_sentinel_master: config.redis_sentinel_master || "",
        redis_sentinel_nodes: config.redis_sentinel_nodes || "",
        redis_sentinel_username: config.redis_sentinel_username || "",
        redis_sentinel_password: config.redis_sentinel_password || "",
        redis_sentinel_tls: config.redis_sentinel_tls || false,
        redis_cluster_nodes: config.redis_cluster_nodes || "",
        redis_key_separator: config.redis_key_separator ?? ":",
        redis_scan_page_size: config.redis_scan_page_size ?? REDIS_SCAN_PAGE_SIZE_DEFAULT,
        etcd_endpoints: config.etcd_endpoints || "",
        informix_server: config.informix_server || "",
        external_config: config.external_config,
        attached_databases: config.attached_databases || [],
        init_script: config.init_script,
        read_only: config.read_only || false,
        is_production: config.is_production || false,
        production_databases: config.production_databases || [],
        visible_databases: config.visible_databases,
      };
      productionProtectionEnabled.value = !!config.is_production || (config.production_databases?.length ?? 0) > 0;
      connectionUrlInput.value = config.db_type === "h2" && config.connection_string ? config.connection_string : "";
      appliedConnectionUrlInput.value = connectionUrlInput.value.trim();
      if (config.db_type === "mq") {
        hydrateMqFields(config.external_config);
      } else {
        resetMqFields();
      }
      if (config.db_type === "nacos") {
        hydrateNacosFields(config.external_config);
      } else {
        resetNacosFields();
      }
      if (config.db_type === "influxdb") {
        hydrateInfluxDbFields(config.external_config);
      } else {
        resetInfluxDbFields();
      }
      resetElasticsearchProxyFields(config.db_type === "elasticsearch" ? config.external_config : undefined);
      resetHiveKerberosFields(config.db_type === "hive" ? config : undefined);
      h2ConnectionMode.value = h2ConnectionModeForConfig(config);
      customColorInput.value = config.color || "";
      selectedTransportLayerId.value = form.value.transport_layers?.[0]?.id || null;
      selectedType.value = profile;
      if (profile === "oceanbase") {
        oceanbaseSubMode.value = oceanbaseMode;
      }
      if (profile === "gbase8a" || profile === "gbase8s") {
        selectedType.value = "gbase";
      }
      dremioConnectionMode.value = profile === "dremio" ? dremioConnectionModeForConfig(config) : "legacy";
      resetDremioConnectionUrls(dremioConnectionMode.value, profile === "dremio" ? config.connection_string : undefined);
      mongoUseUrl.value = !!config.connection_string;
      jdbcDriverPathsInput.value = (config.jdbc_driver_paths || []).join("\n");
      jdbcManualClasspathOpen.value = config.db_type === "prestosql" || (config.jdbc_driver_paths || []).length > 0;
      customDriverName.value = isCustomCompatibleProfile() ? config.driver_label || "" : "";
      dialogStep.value = "config";
      configTab.value = initialConfigTab();
      // Form/profile watchers normalize derived fields in this flush. Capture
      // the saved baseline afterwards so those initial changes are not treated
      // as user edits that invalidate persisted database metadata.
      void nextTick(() => {
        if (open.value && props.editConfig?.id === config.id) applySavedDatabaseInfo(config);
      });
    } else {
      clearSavedDatabaseInfo();
      editingId.value = null;
      form.value = defaultForm();
      productionProtectionEnabled.value = false;
      selectedTransportLayerId.value = null;
      selectedType.value = "mysql";
      customDriverName.value = "";
      resetMqFields();
      resetNacosFields();
      resetInfluxDbFields();
      resetElasticsearchProxyFields();
      resetHiveKerberosFields();
      oceanbaseSubMode.value = "mysql";
      h2ConnectionMode.value = "file";
      dremioConnectionMode.value = "legacy";
      resetDremioConnectionUrls();
      dialogStep.value = "select";
      configTab.value = "connection";
    }
    resetTestState();
  },
  { immediate: true },
);

const isEditing = ref(false);
watch(
  () => editingId.value,
  (v) => {
    isEditing.value = !!v;
  },
);

const databaseLabel = computed(() => {
  if (form.value.db_type === "oracle") return t("connection.serviceName");
  if (form.value.db_type === "influxdb" && influxDbVersion.value === "2") return "Bucket";
  return t("connection.database");
});

const databasePlaceholder = computed(() => {
  if (form.value.db_type === "kingbase") return t("connection.databasePlaceholderRequired");
  const fallback = defaultDatabaseForProfile();
  if (!fallback) return t("connection.databasePlaceholder");
  return t("connection.databasePlaceholderWithDefault", { database: fallback });
});

const transportLayers = computed(() => form.value.transport_layers || []);
const selectedTransportLayer = computed(() => {
  const layers = transportLayers.value;
  return layers.find((layer) => layer.id === selectedTransportLayerId.value) || layers[0] || null;
});
const selectedSshLayer = computed(() => (selectedTransportLayer.value?.type === "ssh" ? selectedTransportLayer.value : null));
const selectedProxyLayer = computed(() => (selectedTransportLayer.value?.type === "proxy" ? selectedTransportLayer.value : null));
const selectedHttpTunnelLayer = computed(() => (selectedTransportLayer.value?.type === "http_tunnel" ? selectedTransportLayer.value : null));

const tunnelProfiles = computed(() => tunnelProfileStore.profiles);
const selectedLayerProfileId = computed(() => selectedTransportLayer.value?.profile_id || "");
const selectedLayerProfile = computed(() => tunnelProfileStore.profileById(selectedLayerProfileId.value));

function tunnelProfileOptionLabel(profile: (typeof tunnelProfiles.value)[number]): string {
  const summary = tunnelProfileSummary(profile);
  if (!profile.name?.trim()) return summary || profile.id;
  return summary ? `${profile.name} (${summary})` : profile.name;
}

function applyTunnelProfileSelection(value: unknown) {
  const selected = selectedTransportLayer.value;
  if (!selected) return;
  if (!value || value === "custom") {
    if (!selected.profile_id) return;
    const detached = detachTunnelProfileLayer(selected, tunnelProfileStore.profileById(selected.profile_id));
    form.value.transport_layers = transportLayers.value.map((layer) => (layer.id === selected.id ? detached : layer));
  } else {
    const profile = tunnelProfileStore.profileById(String(value));
    if (!profile) return;
    const stub = tunnelProfileReferenceLayer(profile, selected);
    form.value.transport_layers = transportLayers.value.map((layer) => (layer.id === selected.id ? stub : layer));
  }
  resetTestState();
}

function transportLayerDefaultName(layer: TransportLayerConfig, index: number): string {
  if (layer.type === "proxy") return `Proxy ${index + 1}`;
  if (layer.type === "http_tunnel") return t("connection.httpTunnelDefaultName", { index: index + 1 });
  return t("connection.sshHopDefaultName", { index: index + 1 });
}

function transportLayerDisplayName(layer: TransportLayerConfig, index: number): string {
  if (layer.profile_id) {
    const profile = tunnelProfileStore.profileById(layer.profile_id);
    if (profile) return profile.name?.trim() || tunnelProfileSummary(profile) || transportLayerDefaultName(layer, index);
    return layer.name?.trim() || t("connection.tunnelProfileMissingName");
  }
  const target = layer.type === "http_tunnel" ? layer.url?.trim() : layer.host?.trim();
  return layer.name?.trim() || target || transportLayerDefaultName(layer, index);
}

const transportPathSegments = computed(() => {
  const layers = transportLayers.value.filter((layer) => layer.enabled !== false);
  return ["DBX", ...layers.map(transportLayerDisplayName), form.value.host || "Database"];
});

function defaultDatabaseForProfile() {
  if (form.value.db_type === "redshift") return "dev";
  if (form.value.db_type === "gaussdb") return "postgres";
  if (form.value.db_type === "kwdb") return "defaultdb";
  if (form.value.db_type === "databend") return "default";
  if (selectedType.value === "cockroachdb") return "defaultdb";
  if (form.value.db_type === "highgo") return "highgo";
  if (form.value.db_type === "yashandb") return "yasdb";
  if (form.value.db_type === "postgres" || form.value.db_type === "vastbase") return "postgres";
  if (form.value.db_type === "sqlserver") return "master";
  if (form.value.db_type === "oracle") return "ORCL";
  if (form.value.db_type === "h2" && h2ConnectionMode.value === "tcp") return "test";
  return "";
}

function onDbTypeChange(val: string) {
  customDriverName.value = "";
  applyProfile(val, !!editingId.value);
  resetTestState();
  resetVisibleSchemasState();
}

function switchH2ConnectionMode(mode: H2ConnectionMode) {
  h2ConnectionMode.value = mode;
  if (mode === "file") {
    form.value.host = h2FilePathFromJdbcUrl(form.value.connection_string) || "";
    form.value.port = 0;
  } else {
    form.value.host = form.value.host.trim() && !isH2FileJdbcUrlLikePath(form.value.host) ? form.value.host : "127.0.0.1";
    form.value.port = form.value.port || 9092;
    if (form.value.connection_string && h2FilePathFromJdbcUrl(form.value.connection_string)) {
      form.value.connection_string = undefined;
    }
  }
  resetTestState();
}

function isH2FileJdbcUrlLikePath(value: string): boolean {
  return /\.(mv|h2)\.db$/i.test(value.trim()) || value.includes("/") || value.includes("\\");
}

const iconTypeMap: Record<string, string> = {
  mysql: "mysql",
  postgres: "postgres",
  sqlite: "sqlite",
  rqlite: "rqlite",
  turso: "turso",
  "cloudflare-d1": "cloudflare-d1",
  access: "access",
  redis: "redis",
  mongodb: "mongodb",
  duckdb: "duckdb",
  clickhouse: "clickhouse",
  sqlserver: "sqlserver",
  oracle: "oracle",
  elasticsearch: "elasticsearch",
  qdrant: "qdrant",
  milvus: "milvus",
  weaviate: "weaviate",
  chromadb: "chromadb",
  mariadb: "mariadb",
  tidb: "tidb",
  oceanbase: "oceanbase",
  "oceanbase-oracle": "oceanbase",
  goldendb: "goldendb",
  databend: "databend",
  tdsql: "tdsql",
  polardb: "polardb",
  greatsql: "greatsql",
  databricks: "databricks",
  saphana: "saphana",
  teradata: "teradata",
  vertica: "vertica",
  firebird: "firebird",
  exasol: "exasol",
  gbase: "gbase",
  opengauss: "opengauss",
  gaussdb: "gaussdb",
  kwdb: "kwdb",
  questdb: "questdb",
  kingbase: "kingbase",
  highgo: "highgo",
  yashandb: "yashandb",
  vastbase: "vastbase",
  doris: "doris",
  selectdb: "selectdb",
  starrocks: "starrocks",
  manticoresearch: "manticoresearch",
  redshift: "redshift",
  cockroachdb: "cockroachdb",
  tdengine: "tdengine",
  xugu: "xugu",
  iotdb: "iotdb",
  etcd: "etcd",
  zookeeper: "zookeeper",
  mq: "mq",
  kafka: "kafka",
  rocketmq: "rocketmq",
  nacos: "nacos",
  dm: "dm",
  h2: "h2",
  snowflake: "snowflake",
  trino: "trino",
  prestosql: "prestosql",
  hive: "hive",
  spark: "spark",
  db2: "db2",
  informix: "informix",
  dremio: "dremio",
  jdbcx: "jdbcx",
  iris: "iris",
  neo4j: "neo4j",
  cassandra: "cassandra",
  bigquery: "bigquery",
  kylin: "kylin",
  sundb: "sundb",
  oscar: "oscar",
  influxdb: "influxdb",
  jdbc: "jdbc",
  custom_mysql: "mysql",
  custom_postgres: "postgres",
};

const dbOptions: DbOption[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mongodb", label: "MongoDB" },
  { value: "redis", label: "Redis" },
  { value: "oracle", label: "Oracle" },
  { value: "sqlite", label: "SQLite" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "elasticsearch", label: "Elasticsearch" },
  { value: "qdrant", label: "Qdrant" },
  { value: "milvus", label: "Milvus" },
  { value: "weaviate", label: "Weaviate" },
  { value: "chromadb", label: "ChromaDB" },
  { value: "dm", label: "达梦 Dameng" },
  { value: "opengauss", label: "openGauss" },
  { value: "turso", label: "Turso" },
  { value: "cloudflare-d1", label: "Cloudflare D1" },
  { value: "duckdb", label: "DuckDB" },
  { value: "rqlite", label: "RQLite" },
  { value: "access", label: "Microsoft Access" },
  { value: "mariadb", label: "MariaDB" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "gaussdb", label: "GaussDB" },
  { value: "kwdb", label: "KWDB" },
  { value: "questdb", label: "QuestDB" },
  { value: "tidb", label: "TiDB" },
  { value: "oceanbase", label: "OceanBase" },
  { value: "goldendb", label: "GoldenDB" },
  { value: "databend", label: "Databend" },
  { value: "tdsql", label: "TDSQL" },
  { value: "polardb", label: "PolarDB" },
  { value: "greatsql", label: "GreatSQL" },
  { value: "doris", label: "Doris" },
  { value: "selectdb", label: "SelectDB" },
  { value: "starrocks", label: "StarRocks" },
  { value: "tdengine", label: "TDengine" },
  { value: "databricks", label: "Databricks SQL" },
  { value: "saphana", label: "SAP HANA" },
  { value: "teradata", label: "Teradata" },
  { value: "vertica", label: "Vertica" },
  { value: "firebird", label: "Firebird" },
  { value: "exasol", label: "Exasol" },
  { value: "gbase", label: "GBase" },
  { value: "kingbase", label: "KingBase" },
  { value: "highgo", label: "瀚高 HighGo" },
  { value: "yashandb", label: "崖山 YashanDB" },
  { value: "vastbase", label: "Vastbase" },
  { value: "redshift", label: "Redshift" },
  { value: "cockroachdb", label: "CockroachDB" },
  { value: "h2", label: "H2" },
  { value: "snowflake", label: "Snowflake" },
  { value: "trino", label: "Trino" },
  { value: "prestosql", label: "PrestoSQL" },
  { value: "hive", label: "Hive" },
  { value: "spark", label: "Apache Spark" },
  { value: "db2", label: "DB2" },
  { value: "informix", label: "Informix" },
  { value: "neo4j", label: "Neo4j" },
  { value: "cassandra", label: "Cassandra" },
  { value: "bigquery", label: "BigQuery" },
  { value: "kylin", label: "Kylin" },
  { value: "sundb", label: "SunDB" },
  { value: "oscar", label: "神通 OSCAR" },
  { value: "xugu", label: "虚谷 XuguDB" },
  { value: "iotdb", label: "Apache IoTDB" },
  { value: "etcd", label: "etcd" },
  { value: "zookeeper", label: "Apache ZooKeeper" },
  { value: "mq", label: "Apache Pulsar" },
  { value: "kafka", label: "Apache Kafka" },
  { value: "rocketmq", label: "Apache RocketMQ" },
  { value: "nacos", label: "Nacos" },
  { value: "influxdb", label: "InfluxDB" },
  { value: "iris", label: "IRIS" },
  { value: "jdbcx", label: "JDBCX" },
  { value: "manticoresearch", label: "Manticore Search" },
  { value: "custom_mysql", label: "Custom (MySQL)" },
  { value: "custom_postgres", label: "Custom (PostgreSQL)" },
  { value: "dremio", label: "Dremio" },
];

const dbCategories = computed<DbCategory[]>(() => [{ key: "all", title: "", options: dbOptions }]);

function matchesDbOption(option: DbOption, keyword: string, categoryTitle = "") {
  const profile = driverProfiles[option.value];
  return [option.label, option.value, profile?.label, profile?.type, categoryTitle].some((value) =>
    String(value || "")
      .toLowerCase()
      .includes(keyword),
  );
}

const filteredDbCategories = computed<DbCategory[]>(() => {
  const keyword = dbSearchQuery.value.trim().toLowerCase();
  if (!keyword) return dbCategories.value;

  return dbCategories.value
    .map((category) => ({
      ...category,
      options: category.options.filter((option) => matchesDbOption(option, keyword, category.title)),
    }))
    .filter((category) => category.options.length > 0);
});

const hasDbPickerResults = computed(() => filteredDbCategories.value.some((category) => category.options.length > 0));
const selectedDbIcon = computed(() => iconTypeMap[selectedType.value] || selectedProfile().icon || selectedType.value);
const jdbcBackedDatabaseTypes = new Set<DatabaseType>(["jdbc", "prestosql"]);
const isJdbcConnection = computed(() => form.value.db_type === "jdbc");
const isJdbcxConnection = computed(() => isJdbcConnection.value && form.value.driver_profile === JDBCX_DRIVER_PROFILE);
const jdbcxHighPrivilegeExtensionsAllowed = computed({
  get: () => jdbcxHighPrivilegeExtensionsEnabled(form.value),
  set: (enabled: boolean) => {
    setJdbcxHighPrivilegeExtensionsEnabled(form.value, enabled);
    resetTestState();
  },
});
const isPrestoSqlConnection = computed(() => form.value.db_type === "prestosql");
const isH2FileMode = computed(() => form.value.db_type === "h2" && h2ConnectionMode.value === "file");
const usesLocalFilePathInput = computed(() => isLocalFileTypeDb(form.value.db_type) && (form.value.db_type !== "h2" || isH2FileMode.value));

const connectionUrlPlaceholder = computed(() => getUrlPlaceholder(form.value.db_type));
const jdbcUsernamePlaceholder = computed(() => (form.value.driver_profile === "dremio" ? "" : "sa"));
const filePathPlaceholder = computed(() => {
  if (form.value.db_type === "duckdb") return "/path/to/database.duckdb or :memory:";
  if (form.value.db_type === "access") return "/path/to/database.accdb";
  if (form.value.db_type === "h2") return "/path/to/database.mv.db";
  return "/path/to/database.db or :memory:";
});
const supportsMemoryDatabasePath = computed(() => form.value.db_type === "sqlite" || form.value.db_type === "duckdb");
const sqliteExtensionPaths = computed({
  get: () => sqliteExtensionPathsFromParams(form.value.url_params),
  set: (value: string) => {
    form.value.url_params = setSqliteExtensionPaths(form.value.url_params, value);
  },
});
const tlsCapableDatabaseTypes = new Set<DatabaseType>(["mysql", "starrocks", "postgres", "redshift", "gaussdb", "kwdb", "opengauss", "questdb", "redis", "etcd", "clickhouse", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "influxdb"]);
const supportsTlsToggle = computed(() => tlsCapableDatabaseTypes.has(form.value.db_type));
const supportsCaCertificatePath = computed(() => form.value.db_type === "clickhouse");
const supportsGenericUrlParams = computed(() => form.value.db_type !== "manticoresearch");
const bareMysqlProfiles = new Set(["doris", "selectdb", "oceanbase"]);
const supportsMysqlTlsOptions = computed(() => form.value.db_type === "starrocks" || (form.value.db_type === "mysql" && !bareMysqlProfiles.has(selectedType.value)));
const supportsMysqlCleartextPasswordAuth = computed(() => form.value.db_type === "mysql" && !bareMysqlProfiles.has(selectedType.value));
const mysqlCleartextPasswordAuth = computed({
  get: () => mysqlCleartextPasswordAuthEnabled(form.value.url_params),
  set: (value: boolean) => {
    form.value.url_params = setMysqlCleartextPasswordAuthEnabled(form.value.url_params, value);
  },
});
const mysqlTlsMode = computed({
  get: () => mysqlTlsModeFromParams(form.value.url_params, form.value.ssl),
  set: (value: string) => {
    form.value.ssl = value !== "preferred" && value !== "disabled";
    form.value.url_params = applyMysqlTlsMode(form.value.url_params, value);
  },
});
const mysqlClientCertPath = computed({
  get: () => getUrlParam(form.value.url_params, "ssl-cert") || getUrlParam(form.value.url_params, "sslcert"),
  set: (value: string) => {
    let next = setUrlParam(form.value.url_params, "sslcert", "");
    form.value.url_params = setUrlParam(next, "ssl-cert", value);
  },
});
const mysqlClientKeyPath = computed({
  get: () => getUrlParam(form.value.url_params, "ssl-key") || getUrlParam(form.value.url_params, "sslkey"),
  set: (value: string) => {
    let next = setUrlParam(form.value.url_params, "sslkey", "");
    form.value.url_params = setUrlParam(next, "ssl-key", value);
  },
});
const nativePostgresTlsDatabaseTypes = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss"]);
const supportsPostgresTlsOptions = computed(() => nativePostgresTlsDatabaseTypes.has(form.value.db_type));
const postgresTlsMode = computed({
  get: () => postgresTlsModeForForm(getUrlParam(form.value.url_params, "sslmode"), form.value.ssl),
  set: (value: string) => {
    form.value.ssl = value !== "disable";
    form.value.url_params = setUrlParam(form.value.url_params, "sslmode", value);
  },
});
const postgresRootCertPath = computed({
  get: () => getUrlParam(form.value.url_params, "sslrootcert"),
  set: (value: string) => {
    form.value.url_params = setUrlParam(form.value.url_params, "sslrootcert", value);
  },
});
const postgresClientCertPath = computed({
  get: () => getUrlParam(form.value.url_params, "sslcert"),
  set: (value: string) => {
    form.value.url_params = setUrlParam(form.value.url_params, "sslcert", value);
  },
});
const postgresClientKeyPath = computed({
  get: () => getUrlParam(form.value.url_params, "sslkey"),
  set: (value: string) => {
    form.value.url_params = setUrlParam(form.value.url_params, "sslkey", value);
  },
});
const redisTlsInsecure = computed({
  get: () => getUrlParam(form.value.url_params, "insecure").toLowerCase() === "true",
  set: (value: boolean) => {
    form.value.url_params = setUrlParam(form.value.url_params, "insecure", value ? "true" : "");
  },
});
const etcdEndpointsLines = computed({
  get: () => form.value.etcd_endpoints || "",
  set: (value: string) => {
    form.value.etcd_endpoints = normalizeEndpointLines(value);
  },
});
const zookeeperConnectString = computed({
  get: () => form.value.connection_string || "",
  set: (value: string) => {
    form.value.connection_string = normalizeZooKeeperConnectString(value);
  },
});
const canUseTransportLayers = computed(() => form.value.db_type !== "sqlite" && form.value.db_type !== "access" && !isCloudflareD1Connection(form.value) && !isH2FileMode.value);
const shouldShowAgentDriverInstallHint = computed(() => showAgentDriverInstallHint(form.value.db_type, agentDrivers.value, form.value.driver_profile));
const h2DriverMissing = computed(() => form.value.db_type === "h2" && isH2FileMode.value && agentDrivers.value.find((d) => d.db_type === "h2")?.installed !== true);
const agentDriverFocus = computed<DriverStoreFocus>(() => ({ target: "driver", driver: agentDriverInstallKey(form.value.db_type, form.value.driver_profile) }));
const canChooseVisibleDatabases = computed(() => connectionCanChooseVisibleDatabases(form.value));
const visibleFilterUsesSchemas = computed(() => connectionUsesVisibleSchemaFilter(form.value));
const hasVisibleDatabaseFilter = computed(() => Array.isArray(form.value.visible_databases));
const visibleDatabaseSummary = computed(() => {
  const configured = form.value.visible_databases;
  if (!Array.isArray(configured)) return t("visibleDatabases.showAll");
  return t("visibleDatabases.selectedCount", { selected: configured.length, total: visibleDatabaseNames.value.length });
});
const listedVisibleDatabaseNames = computed(() => {
  if (visibleFilterUsesSchemas.value) return visibleDatabaseNames.value;
  const connection = connectionConfigSnapshotForVisibleDatabases();
  if (visibleDatabaseShowSystem.value) return visibleDatabaseNames.value;
  return filterDatabaseNamesForVisiblePicker(visibleDatabaseNames.value, connection);
});
const filteredVisibleDatabaseNames = computed(() => {
  const query = visibleDatabaseSearchText.value.trim().toLowerCase();
  if (!query) return listedVisibleDatabaseNames.value;
  return listedVisibleDatabaseNames.value.filter((name) => name.toLowerCase().includes(query));
});
const visibleDatabaseSelectedCount = computed(() => visibleDatabaseSelection.value.size);
const visibleDatabaseTotalCount = computed(() => listedVisibleDatabaseNames.value.length);
const visibleDatabaseCanSave = computed(() => canSaveVisibleDatabaseSelection([...visibleDatabaseSelection.value]));
const visibleDatabaseHasSystemDatabases = computed(() => {
  if (visibleFilterUsesSchemas.value) return false;
  const connection = connectionConfigSnapshotForVisibleDatabases();
  return visibleDatabaseNames.value.some((database) => isSystemDatabaseName(connection.db_type, database));
});
const filteredProductionDatabaseNames = computed(() => {
  const query = productionDatabaseSearchText.value.trim().toLowerCase();
  if (!query) return productionDatabaseNames.value;
  return productionDatabaseNames.value.filter((name) => name.toLowerCase().includes(query));
});
const productionDatabaseSelectedCount = computed(() => productionDatabaseSelection.value.size);
const productionDatabaseCanSave = computed(() => productionDatabaseNames.value.length > 0 && productionDatabaseSelection.value.size > 0);
const productionDatabaseSummary = computed(() => {
  const selected = form.value.production_databases?.length || 0;
  if (!selected) return t("production.noDatabasesSelected");
  if (!productionDatabaseNames.value.length) return t("production.databasesConfiguredCount", { count: selected });
  return t("production.databasesSelectedCount", { selected, total: productionDatabaseNames.value.length });
});
const productionScope = computed<ProductionScope>({
  get: () => (isSingleDatabase(form.value.db_type) || form.value.is_production ? "connection" : "databases"),
  set: (scope) => {
    form.value.is_production = isSingleDatabase(form.value.db_type) || scope === "connection";
  },
});
const canSelectProductionDatabases = computed(() => !isSingleDatabase(form.value.db_type));

function setProductionProtectionEnabled(enabled: boolean) {
  productionProtectionEnabled.value = enabled;
  if (!enabled) {
    form.value.is_production = false;
    form.value.production_databases = [];
  } else if (!form.value.is_production && !form.value.production_databases?.length) {
    // Enabling protection starts with the broadest scope until the user chooses a narrower one.
    form.value.is_production = true;
  }
}
const canChooseVisibleSchemas = computed(() => isSchemaAware(form.value.db_type));
const visibleSchemasDatabaseKey = computed(() => form.value.database || "");
const hasVisibleSchemaFilter = computed(() => {
  const key = visibleSchemasDatabaseKey.value;
  return Array.isArray(form.value.visible_schemas?.[key]);
});
const visibleSchemaObjectSelection = computed(() => {
  const configured = form.value.visible_schemas?.[visibleSchemasDatabaseKey.value];
  if (Array.isArray(configured)) return configured;
  if (visibleFilterUsesSchemas.value && Array.isArray(form.value.visible_databases)) return form.value.visible_databases;
  return undefined;
});
const visibleSchemaSummary = computed(() => {
  const key = visibleSchemasDatabaseKey.value;
  const configured = form.value.visible_schemas?.[key];
  if (!Array.isArray(configured)) return t("visibleSchemas.showAll");
  return t("visibleSchemas.selectedCount", { selected: configured.length, total: visibleSchemaNames.value.length });
});
const hasVisibleObjectFilter = computed(() => (visibleFilterUsesSchemas.value ? Array.isArray(visibleSchemaObjectSelection.value) : hasVisibleDatabaseFilter.value));
const visibleObjectSummary = computed(() => {
  if (!visibleFilterUsesSchemas.value) return visibleDatabaseSummary.value;
  const configured = visibleSchemaObjectSelection.value;
  if (!Array.isArray(configured)) return t("visibleSchemas.showAll");
  return t("visibleSchemas.selectedCount", { selected: configured.length, total: visibleDatabaseNames.value.length });
});
const visibleObjectTitleKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.title" : "visibleDatabases.title"));
const visibleObjectDescriptionKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.description" : "visibleDatabases.description"));
const visibleObjectSearchPlaceholderKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.searchPlaceholder" : "visibleDatabases.searchPlaceholder"));
const visibleObjectSelectedCountKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.selectedCount" : "visibleDatabases.selectedCount"));
const visibleObjectEmptySelectionKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.emptySelection" : "visibleDatabases.emptySelection"));
const visibleObjectLoadFailedKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.loadFailed" : "visibleDatabases.loadFailed"));
const visibleObjectSaveKey = computed(() => (visibleFilterUsesSchemas.value ? "visibleSchemas.save" : "visibleDatabases.save"));
const databaseInfoLabelKeys: Record<DatabaseInfoField, string> = {
  productName: "connection.databaseInfo.productName",
  productVersion: "connection.databaseInfo.productVersion",
  currentDatabase: "connection.databaseInfo.currentDatabase",
  serverComment: "connection.databaseInfo.serverComment",
  serverCharset: "connection.databaseInfo.serverCharset",
  serverCollation: "connection.databaseInfo.serverCollation",
  unquotedIdentifierCase: "connection.databaseInfo.unquotedIdentifierCase",
  quotedIdentifierCase: "connection.databaseInfo.quotedIdentifierCase",
  driverName: "connection.databaseInfo.driverName",
  driverVersion: "connection.databaseInfo.driverVersion",
  jdbcVersion: "connection.databaseInfo.jdbcVersion",
};
function databaseInfoFieldLabel(field: DatabaseInfoField): string {
  return t(databaseInfoLabelKeys[field]);
}
function databaseIdentifierCaseLabel(value: IdentifierCase): string {
  return t(`connection.databaseInfo.identifierCase.${value}`);
}
const visibleTestDatabaseInfo = computed<DatabaseConnectionInfo | null>(() => {
  const result = testResult.value;
  if (!result?.ok || !result.databaseInfo || !testedConfigFingerprint.value || !testedConfigId.value) return null;
  try {
    const current = connectionConfigForSubmit(testedConfigId.value, testedGeneratedName.value);
    return connectionConfigFingerprint(current, form.value.name) === testedConfigFingerprint.value ? result.databaseInfo : null;
  } catch {
    return null;
  }
});
const visibleSavedDatabaseInfo = computed<DatabaseConnectionInfo | null>(() => {
  if (!savedDatabaseInfo.value || !savedDatabaseInfoFingerprint.value || !editingId.value) return null;
  try {
    const current = connectionConfigForSubmit(editingId.value, form.value.name);
    return connectionConfigFingerprint(current, form.value.name) === savedDatabaseInfoFingerprint.value ? savedDatabaseInfo.value : null;
  } catch {
    return null;
  }
});
const configuredDatabaseInfo = computed<DatabaseConnectionInfo | null>(() => {
  const productName = configuredDatabaseProductName({
    db_type: form.value.db_type,
    driver_label: form.value.driver_label,
  });
  return normalizeDatabaseConnectionInfo(undefined, productName, form.value.database) ?? null;
});
const visibleDatabaseInfo = computed<DatabaseConnectionInfo | null>(() => visibleTestDatabaseInfo.value ?? visibleSavedDatabaseInfo.value ?? configuredDatabaseInfo.value);
const databaseInfoVerified = computed(() => !!visibleTestDatabaseInfo.value || !!visibleSavedDatabaseInfo.value);
const databaseInfoStatusLabel = computed(() => (databaseInfoVerified.value ? t("connection.databaseInfo.sourceTested") : t("connection.databaseInfo.sourceConfigured")));
const databaseInfoDescription = computed(() => (databaseInfoVerified.value ? t("connection.databaseInfo.testedDescription") : t("connection.databaseInfo.configuredDescription")));
const databaseInfoDisplayRows = computed(() =>
  visibleDatabaseInfo.value
    ? databaseInfoRows(visibleDatabaseInfo.value).map((row) => ({
        ...row,
        label: databaseInfoFieldLabel(row.key),
        displayValue: row.key === "unquotedIdentifierCase" || row.key === "quotedIdentifierCase" ? databaseIdentifierCaseLabel(row.value as IdentifierCase) : row.value,
      }))
    : [],
);
const databaseInfoCompactLabel = computed(() =>
  databaseInfoDisplayRows.value
    .filter((row) => row.key === "productName" || row.key === "productVersion" || row.key === "currentDatabase")
    .slice(0, 3)
    .map((row) => row.displayValue)
    .join(" · "),
);
const testResultMessage = computed(() => {
  if (!testResult.value) return "";
  return testResult.value.ok ? t("connection.testSuccess") : translateBackendError(t, testResult.value.message);
});
const agentInstallPercent = computed(() => driverInstallProgressPercent(agentInstallProgress.value));
const agentInstallProgressLabel = computed(() => {
  const progress = agentInstallProgress.value;
  if (agentInstallError.value) return "安装失败";
  if (!agentInstallRunning.value) return "等待安装";
  if (!progress) return "准备安装驱动...";
  if (progress.step === "jre-extract") return "解压 JRE...";
  const label = progress.step === "jre" ? "下载 JRE" : progress.step === "driver" ? "下载驱动" : progress.step || "安装驱动";
  if (!progress.total) return `${label}...`;
  return `${label} ${formatInstallSize(progress.downloaded ?? 0)} / ${formatInstallSize(progress.total)} (${agentInstallPercent.value ?? 0}%)`;
});
const canCloseAgentInstallDialog = computed(() => !agentInstallRunning.value || !!agentInstallError.value);
const sqlServerLegacyCompatibilityModeEnabled = computed(() => form.value.db_type === "sqlserver" && isSqlServerLegacyCompatibilityMode(form.value.url_params));
const shouldUseWideConnectionDialog = computed(() => dialogStep.value === "config" && (canChooseVisibleDatabases.value || (canChooseVisibleSchemas.value && !visibleFilterUsesSchemas.value)));
const connectionDialogContentClass = computed(() => {
  if (dialogStep.value === "select") return "sm:max-w-[760px]";
  return shouldUseWideConnectionDialog.value ? "sm:max-w-[660px]" : "sm:max-w-[560px]";
});
const connectionLabelClass = "justify-self-start text-left";
const connectionLabelSmallClass = `${connectionLabelClass} text-xs`;
const connectionLabelTopClass = `${connectionLabelClass} mt-2`;
const connectionLabelSmallPaddedClass = `${connectionLabelClass} pt-2 text-xs`;
const hasRequiredConnectionTarget = computed(() => {
  if (form.value.db_type === "mq") {
    if (mqSystemKind.value === "kafka") return !!mqKafkaBootstrapServers.value.trim();
    if (mqSystemKind.value === "rocketmq") return !!mqRocketmqNamesrvAddr.value.trim();
    return !!mqAdminUrl.value.trim();
  }
  if (form.value.db_type === "zookeeper") return !!(form.value.host || form.value.connection_string || connectionUrlInput.value.trim());
  if (form.value.db_type === "nacos") return !!nacosServerAddr.value.trim();
  if (isCloudflareD1Connection(form.value)) return hasCloudflareD1Credentials(form.value);
  if (isH2FileMode.value) return !!(form.value.host.trim() || h2FilePathFromJdbcUrl(form.value.connection_string));
  return !!(form.value.host || (mongoUseUrl.value && form.value.connection_string) || (form.value.db_type === "jdbc" && form.value.connection_string) || connectionUrlInput.value.trim());
});
const mongoAuthDatabase = computed({
  get: () => mongoUrlParam(form.value.url_params, "authSource"),
  set: (value: string) => {
    form.value.url_params = setMongoUrlParam(form.value.url_params, "authSource", value);
  },
});
const mongoAuthMechanism = computed({
  get: () => mongoUrlParam(form.value.url_params, "authMechanism") || "default",
  set: (value: string) => {
    form.value.url_params = setMongoUrlParam(form.value.url_params, "authMechanism", value === "default" ? "" : value);
  },
});
const mongoTlsAllowInvalidCertificates = computed({
  get: () => mongoUrlParamIsTrue(form.value.url_params, "tlsAllowInvalidCertificates"),
  set: (value: boolean) => {
    let next = setMongoUrlParamBoolean(form.value.url_params, "tlsAllowInvalidCertificates", value);
    next = setMongoUrlParam(next, "tlsAllowInvalidHostnames", "");
    form.value.url_params = next;
  },
});
const mongoRetryWrites = computed({
  get: () => mongoUrlParamIsTrue(form.value.url_params, "retryWrites", true),
  set: (value: boolean) => {
    form.value.url_params = setMongoUrlParamBoolean(form.value.url_params, "retryWrites", value, true);
  },
});
const mongoDriverMode = computed({
  get: () => (form.value.driver_profile === "mongodb-legacy" ? "legacy" : "auto"),
  set: (value: string) => {
    form.value.driver_profile = value === "legacy" ? "mongodb-legacy" : "mongodb";
    form.value.driver_label = value === "legacy" ? "MongoDB (Legacy)" : "MongoDB";
  },
});

function goToConnectionStep(value = selectedType.value) {
  if (value !== selectedType.value) {
    onDbTypeChange(value);
  }
  dialogStep.value = "config";
  configTab.value = "connection";
  dbSearchQuery.value = "";
}

function backToDatabasePicker() {
  dialogStep.value = "select";
  resetTestState();
}

watch(customDriverName, (value) => {
  if (isCustomCompatibleProfile()) {
    form.value.driver_label = value.trim() || selectedProfile().label;
  }
});

async function testConnection() {
  if (!ensureConnectionHostResolvedFromUrl()) return;

  const runId = ++testRunId;
  isTesting.value = true;
  testResult.value = null;
  let config: ConnectionConfig | null = null;
  const submittedSourceName = form.value.name;
  try {
    config = connectionConfigForSubmit(editingId.value || draftTestConnectionId.value);
    await ensureRequiredAgentDriverInstalled(config);
    await ensureRequiredJdbcxDriverInstalled(config);
    const result = await testConnectionWithTimeout(config, runId);
    if (runId !== testRunId) return;
    let successfulConfig = config;
    if (config.db_type === "mongodb" && /legacy driver/i.test(result.message)) {
      mongoDriverMode.value = "legacy";
      successfulConfig = connectionConfigForSubmit(config.id, config.name);
    }
    applySuccessfulConnectionTest(result, successfulConfig, submittedSourceName);
    void persistSuccessfulConnectionTest(result, successfulConfig, submittedSourceName, runId);
    clearEditedConnectionErrorAfterSuccessfulTest();
  } catch (e: any) {
    if (runId !== testRunId) return;
    const rawMessage = mongodbAuthFailureHint(errorMessage(e));
    const message = config ? connectionErrorWithDriverUpdateHint(config, rawMessage) : rawMessage;
    const fallback = config ? await tryNacosDockerConsoleFallback(config, message, runId) : null;
    if (runId !== testRunId) return;
    const shouldShowSqlServerLegacyMode = !fallback && config?.db_type === "sqlserver" && !isSqlServerLegacyCompatibilityMode(config.url_params) && isSqlServerTlsHandshakeFailure(message);
    if (shouldShowSqlServerLegacyMode) {
      configTab.value = "advanced";
    }
    if (fallback) {
      applySuccessfulConnectionTest(fallback.result, fallback.config, submittedSourceName);
      void persistSuccessfulConnectionTest(fallback.result, fallback.config, submittedSourceName, runId);
      clearEditedConnectionErrorAfterSuccessfulTest();
    } else {
      clearTestedConnectionInfo();
      testResult.value = { ok: false, message };
      showConnectionError(message);
    }
  } finally {
    if (runId === testRunId) {
      isTesting.value = false;
    }
  }
}

function clearEditedConnectionErrorAfterSuccessfulTest() {
  if (editingId.value) store.clearConnectionError(editingId.value);
}

function applyConnectionUrlToForm(input: string): boolean {
  try {
    const draft = parseConnectionDeepLink(input);
    if (draft) {
      applyConnectionDraftToForm({ ...draft, oneTime: undefined });
      resetTestState();
      appliedConnectionUrlInput.value = input.trim();
      return true;
    }

    const parsed = parseConnectionUrl(input, selectedType.value);
    form.value = applyParsedConnectionUrl(form.value, parsed);
    selectedType.value = parsed.driverProfile;
    customDriverName.value = isCustomCompatibleProfile() ? parsed.driverLabel : "";
    mongoUseUrl.value = !!parsed.useMongoUrl;
    if (form.value.db_type === "h2") {
      h2ConnectionMode.value = h2ConnectionModeForConfig(form.value);
    }
    if (!form.value.name.trim()) {
      form.value.name = parsed.database || parsed.host || parsed.driverLabel;
    }
    resetTestState();
    appliedConnectionUrlInput.value = input.trim();
    return true;
  } catch (e: any) {
    toast(t("connection.parseConnectionUrlFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

function hasPendingConnectionUrlInput(): boolean {
  const url = connectionUrlInput.value.trim();
  return !!url && url !== appliedConnectionUrlInput.value;
}

function ensureConnectionHostResolvedFromUrl(): boolean {
  if (!hasPendingConnectionUrlInput()) return true;
  return applyConnectionUrlToForm(connectionUrlInput.value.trim());
}

function formValueForSubmit(): Omit<ConnectionConfig, "id"> {
  const url = connectionUrlInput.value.trim();
  if (!url || url === appliedConnectionUrlInput.value) return form.value;

  const draft = parseConnectionDeepLink(url);
  if (draft) {
    return applyConnectionDraftToConfig(form.value, { ...draft, oneTime: undefined });
  }

  return applyParsedConnectionUrl(form.value, parseConnectionUrl(url, selectedType.value));
}

function applyDremioJdbcMetadata(config: LegacyConnectionConfig) {
  config.connection_string = config.connection_string?.trim() || dremioDefaultConnectionUrl();
  try {
    const parsed = parseConnectionUrl(config.connection_string);
    if (parsed.driverProfile !== "dremio") return;
    config.host = parsed.host;
    config.port = parsed.port;
    config.database = config.database?.trim() || parsed.database;
    config.connection_string = dremioConnectionStringForSubmit(config.connection_string, config.url_params, config.database);
    config.url_params = "";
    if (!config.username) config.username = parsed.username;
    if (!config.password) config.password = parsed.password;
  } catch {
    // Keep custom JDBC input editable; the agent will surface driver-specific URL errors.
  }
}

function dremioConnectionStringForSubmit(connectionString: string, urlParams: string | undefined, database: string | undefined) {
  const params = dremioSubmitUrlParams(connectionString, urlParams, database);
  if (!params) return connectionString;
  return `${connectionString}${dremioSubmitUrlParamSeparator(connectionString)}${params}`;
}

function dremioSubmitUrlParams(connectionString: string | undefined, urlParams: string | undefined, database: string | undefined) {
  const existingKeys = dremioUrlParamKeys(connectionString || "");
  const extraParams = filterDremioUrlParams(urlParams || "", existingKeys);
  if (database?.trim() && !existingKeys.has("schema") && !dremioUrlParamKeys(extraParams.join("&")).has("schema")) {
    extraParams.push(`schema=${database.trim()}`);
  }
  return extraParams.join(dremioConnectionStringUsesLegacyUrlParams(connectionString || "") ? ";" : "&");
}

function dremioSubmitUrlParamSeparator(connectionString: string) {
  if (dremioConnectionStringUsesLegacyUrlParams(connectionString)) {
    return connectionString.endsWith(";") ? "" : ";";
  }
  return connectionString.includes("?") ? (connectionString.endsWith("?") || connectionString.endsWith("&") ? "" : "&") : "?";
}

function dremioConnectionStringUsesLegacyUrlParams(connectionString: string) {
  if (/^jdbc:dremio:/i.test(connectionString)) return true;
  if (/^jdbc:arrow-flight-sql:\/\//i.test(connectionString)) return false;
  return dremioConnectionMode.value === "legacy";
}

function filterDremioUrlParams(urlParams: string, existingKeys: Set<string>) {
  const result: string[] = [];
  for (const part of urlParams.split(/[&;]/)) {
    const param = part.trim();
    if (!param) continue;
    const key = param.split("=")[0]?.trim().toLowerCase();
    if (!key || existingKeys.has(key)) continue;
    result.push(param);
  }
  return result;
}

function dremioUrlParamKeys(value: string) {
  const keys = new Set<string>();
  const params = dremioUrlParamString(value);
  for (const part of params.split(/[&;]/)) {
    const key = part.split("=")[0]?.trim().toLowerCase();
    if (key) keys.add(key);
  }
  return keys;
}

function dremioUrlParamString(value: string) {
  if (/^jdbc:dremio:/i.test(value)) {
    return value.split(";").slice(1).join(";");
  }
  const queryStart = value.indexOf("?");
  if (queryStart < 0) return value;
  const fragmentStart = value.indexOf("#", queryStart + 1);
  return value.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
}

function generateConnectionName(): string {
  const label = selectedProfile().label;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${label}_${rand}`;
}

function connectionConfigForSubmit(id: string, generatedName = ""): ConnectionConfig {
  const config = { ...formValueForSubmit(), id } as LegacyConnectionConfig;
  config.database_info = undefined;
  if (selectedType.value === "oceanbase" && (config.driver_profile === "oceanbase" || config.driver_profile === "oceanbase-oracle")) {
    Object.assign(config, oceanbaseModeConnectionPatch(oceanbaseSubMode.value));
  }
  if (!config.name?.trim()) {
    config.name = generatedName.trim() || generateConnectionName();
  }
  if (config.db_type === "kingbase") {
    config.database = config.database?.trim() || undefined;
    if (!config.database) {
      throw new Error(t("connection.kingbaseDatabaseRequired"));
    }
  }
  if (isCloudflareD1Connection(config)) {
    normalizeCloudflareD1Connection(config);
    if (!hasCloudflareD1Credentials(config)) {
      throw new Error(t("connection.d1FieldsRequired"));
    }
  }
  config.transport_layers = (config.transport_layers || []).map(normalizeTransportLayer);
  config.transport_layers = config.transport_layers.map((layer) => {
    if (layer.type !== "ssh") return layer;
    const normalized = normalizeSshTunnel(layer);
    const timeout = Number(normalized.connect_timeout_secs);
    normalized.connect_timeout_secs = Number.isFinite(timeout) && timeout > 0 ? timeout : 5;
    return { type: "ssh", ...normalized };
  });
  validateTransportLayers(config);
  const connectTimeout = Number(config.connect_timeout_secs);
  config.connect_timeout_secs = Number.isFinite(connectTimeout) && connectTimeout > 0 ? connectTimeout : 10;
  const queryTimeout = Number(config.query_timeout_secs);
  config.query_timeout_secs = Number.isFinite(queryTimeout) && queryTimeout >= 0 ? queryTimeout : 30;
  const idleTimeout = Number(config.idle_timeout_secs);
  config.idle_timeout_secs = Number.isFinite(idleTimeout) && idleTimeout >= 0 ? idleTimeout : 60;
  const keepaliveInterval = Number(config.keepalive_interval_secs);
  config.keepalive_interval_secs = Number.isFinite(keepaliveInterval) && keepaliveInterval >= 0 ? keepaliveInterval : 30;
  if (config.db_type === "manticoresearch") {
    config.url_params = "";
  }
  if (config.db_type === "hive") {
    if (hiveAuthMode.value === "kerberos" && !hivePrincipal.value.trim()) {
      throw new Error(t("connection.hiveKerberosPrincipalRequired"));
    }
    const hiveKerberos = applyHiveKerberosSubmitConfig({
      authMode: hiveAuthMode.value,
      principal: hivePrincipal.value,
      krb5ConfPath: hiveKrb5ConfPath.value,
      jaasConfigPath: hiveJaasConfigPath.value,
      useSubjectCredsOnlyFalse: hiveUseSubjectCredsOnlyFalse.value,
      extraJavaOptions: hiveExtraJavaOptions.value,
      urlParams: config.url_params,
    });
    config.url_params = hiveKerberos.urlParams;
    config.agent_java_options = hiveKerberos.agentJavaOptions;
  } else if (!(config.db_type === "jdbc" && config.driver_profile === JDBCX_DRIVER_PROFILE)) {
    config.agent_java_options = undefined;
  }
  if (config.db_type === "informix" && config.informix_server) {
    // Strip INFORMIXSERVER from url_params to avoid duplicate when dedicated field is used
    config.url_params = (config.url_params || "")
      .replace(/(?:^|[;])\s*INFORMIXSERVER\s*=[^;]*/gi, "")
      .replace(/^[;]|[;]$/g, "")
      .trim();
  }
  if (!config.one_time) config.one_time = undefined;
  if (!config.read_only) config.read_only = undefined;
  if (isSingleDatabase(config.db_type) && config.production_databases?.length) {
    // Single-database drivers expose schemas or internal names, not independently selectable databases.
    config.is_production = true;
    config.production_databases = [];
  }
  if (!config.is_production) config.is_production = undefined;
  config.production_databases = [...new Set((config.production_databases || []).map((database) => database.trim()).filter(Boolean))];
  if (!config.production_databases.length) config.production_databases = undefined;
  if (form.value.db_type === "mq") {
    const mqConfig = buildMqAdminConfig();
    config.external_config = mqConfig;
    config.driver_profile = mqConfig.systemKind;
    config.driver_label = MQ_DRIVER_LABELS[mqConfig.systemKind];
    if (mqConfig.systemKind === "kafka") {
      const extra = mqExtraRecord(mqConfig);
      applyMqKafkaBootstrapServers(config, mqExtraString(extra, "bootstrapServers"), mqExtraString(extra, "securityProtocol"));
    } else if (mqConfig.systemKind === "rocketmq") {
      const extra = mqExtraRecord(mqConfig);
      applyMqRocketmqNamesrv(config, mqExtraString(extra, "namesrvAddr") || mqExtraString(extra, "namesrv_addr"));
    } else {
      applyMqAdminUrl(config, mqConfig.adminUrl);
    }
    config.username = "";
    config.password = "";
    config.database = undefined;
    config.connection_string = undefined;
    config.url_params = "";
  } else if (config.db_type === "nacos") {
    const nacosConfig = buildNacosAdminConfig();
    config.external_config = nacosConfig;
    applyNacosServerAddr(config, nacosConfig.serverAddr);
    config.username = nacosAuthKind.value === "usernamePassword" ? nacosUsername.value.trim() : "";
    config.password = nacosAuthKind.value === "usernamePassword" ? nacosPassword.value : "";
    config.database = nacosConfig.namespace || undefined;
    config.connection_string = undefined;
    config.url_params = "";
  } else if (config.db_type === "influxdb") {
    config.external_config = buildInfluxDbExternalConfig();
    config.connection_string = undefined;
    if (influxDbVersion.value === "2") {
      config.username = "";
      config.password = config.password.trim();
      config.database = config.database?.trim() || undefined;
    }
  } else if (config.db_type === "elasticsearch") {
    config.external_config = buildElasticsearchExternalConfig(elasticsearchConnectionMode.value, elasticsearchKibanaBasePath.value);
  } else if (config.db_type === "sqlserver") {
    config.external_config = sqlServerPortExplicitFromConfig(config) ? { portExplicit: true } : undefined;
  } else {
    config.external_config = undefined;
  }
  if (config.db_type === "mongodb" && !mongoUseUrl.value) {
    config.connection_string = undefined;
  } else if (config.db_type === "mongodb") {
    config.connection_string = normalizeMongoConnectionString(config.connection_string?.trim() || "");
  }
  if (config.db_type === "mongodb" && config.driver_profile !== "mongodb-legacy") {
    config.driver_profile = "mongodb";
    config.driver_label = "MongoDB";
  }
  if (config.db_type === "mongodb") {
    const mongoTls = normalizeMongoTlsFormState(!!config.ssl, config.url_params, config.ca_cert_path);
    config.url_params = mongoTls.urlParams;
    config.ca_cert_path = mongoTls.caCertPath;
  }
  if (config.db_type !== "oracle") {
    config.sysdba = undefined;
    config.oracle_connection_type = undefined;
  } else {
    config.sysdba = !!config.sysdba || isOracleSysUser(config);
    config.oracle_connection_type = config.oracle_connection_type || "service_name";
  }
  if (config.db_type !== "redis") {
    config.redis_connection_mode = undefined;
    config.redis_sentinel_master = undefined;
    config.redis_sentinel_nodes = undefined;
    config.redis_sentinel_username = undefined;
    config.redis_sentinel_password = undefined;
    config.redis_sentinel_tls = undefined;
    config.redis_cluster_nodes = undefined;
    config.redis_key_separator = undefined;
    config.redis_scan_page_size = undefined;
  } else if (config.redis_connection_mode === "sentinel") {
    config.redis_sentinel_master = config.redis_sentinel_master?.trim() || "";
    config.redis_sentinel_nodes = normalizeRedisSentinelNodes(config.redis_sentinel_nodes || "");
    config.redis_sentinel_username = config.redis_sentinel_username?.trim() || "";
    config.redis_cluster_nodes = undefined;
    const firstNode = firstRedisSentinelEndpoint(config.redis_sentinel_nodes);
    if (firstNode) {
      config.host = firstNode.host;
      config.port = firstNode.port;
    }
  } else if (config.redis_connection_mode === "cluster") {
    config.redis_sentinel_master = undefined;
    config.redis_sentinel_nodes = undefined;
    config.redis_sentinel_username = undefined;
    config.redis_sentinel_password = undefined;
    config.redis_sentinel_tls = undefined;
    config.redis_cluster_nodes = normalizeRedisClusterNodes(config.redis_cluster_nodes || "");
    const firstNode = firstRedisClusterEndpoint(config.redis_cluster_nodes);
    if (firstNode) {
      config.host = firstNode.host;
      config.port = firstNode.port;
    }
  } else {
    config.redis_connection_mode = "standalone";
    config.redis_sentinel_master = undefined;
    config.redis_sentinel_nodes = undefined;
    config.redis_sentinel_username = undefined;
    config.redis_sentinel_password = undefined;
    config.redis_sentinel_tls = undefined;
    config.redis_cluster_nodes = undefined;
  }
  if (config.db_type === "redis") {
    config.redis_key_separator = config.redis_key_separator?.trim() ?? ":";
    const scanSize = Number(config.redis_scan_page_size);
    config.redis_scan_page_size = Number.isFinite(scanSize) && scanSize >= REDIS_SCAN_PAGE_SIZE_MIN && scanSize <= REDIS_SCAN_PAGE_SIZE_MAX ? Math.round(scanSize) : REDIS_SCAN_PAGE_SIZE_DEFAULT;
  }
  if (config.db_type === "zookeeper") {
    const normalizedConnectString = normalizeZooKeeperConnectString(config.connection_string || "");
    config.connection_string = normalizedConnectString || undefined;
    const firstEndpoint = firstZooKeeperEndpoint(normalizedConnectString || (config.host ? `${config.host}:${config.port || 2181}` : ""));
    if (firstEndpoint) {
      config.host = firstEndpoint.host;
      config.port = firstEndpoint.port;
    }
    config.database = undefined;
    config.ssl = false;
  }
  if (config.db_type === "etcd") {
    config.etcd_endpoints = normalizeEndpointLines(config.etcd_endpoints || "");
    const firstEndpoint = firstEtcdEndpoint(config.etcd_endpoints);
    if (firstEndpoint) {
      config.host = firstEndpoint.host;
      config.port = firstEndpoint.port;
      config.ssl = firstEndpoint.scheme === "https" || !!config.ssl;
    }
    config.client_cert_path = config.client_cert_path?.trim() || "";
    config.client_key_path = config.client_key_path?.trim() || "";
    if ((config.client_cert_path && !config.client_key_path) || (!config.client_cert_path && config.client_key_path)) {
      throw new Error(t("connection.etcdClientCertPairRequired"));
    }
  } else {
    config.etcd_endpoints = undefined;
    config.client_cert_path = undefined;
    config.client_key_path = undefined;
  }
  if (config.db_type !== "mysql" && config.db_type !== "clickhouse" && config.db_type !== "etcd" && config.db_type !== "starrocks" && config.db_type !== "mongodb") {
    config.ca_cert_path = undefined;
  } else {
    config.ca_cert_path = config.ca_cert_path?.trim() || "";
  }
  if (jdbcBackedDatabaseTypes.has(config.db_type)) {
    if (config.db_type === "jdbc") {
      if (config.driver_profile === "dremio") {
        applyDremioJdbcMetadata(config);
      } else if (config.driver_profile === JDBCX_DRIVER_PROFILE) {
        config.host = "";
        config.port = 0;
        config.connection_string = config.connection_string?.trim() || JDBCX_DEFAULT_URL;
        config.jdbc_driver_class = config.jdbc_driver_class?.trim() || JDBCX_JDBC_DRIVER_CLASS;
      } else {
        config.host = "";
        config.port = 0;
        config.connection_string = config.connection_string?.trim() || "";
      }
    } else if (config.db_type === "prestosql") {
      config.connection_string = undefined;
      config.jdbc_driver_class = config.jdbc_driver_class?.trim() || "io.prestosql.jdbc.PrestoDriver";
      applyPrestoSqlBuiltinDriverPathsIfAvailable();
    }
    config.jdbc_driver_class = config.jdbc_driver_class?.trim() || undefined;
    config.jdbc_driver_paths = jdbcDriverPathsInput.value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  }
  if (config.db_type === "h2") {
    const h2Mode = connectionUrlInput.value.trim() ? h2ConnectionModeForConfig(config) : h2ConnectionMode.value;
    if (h2Mode === "file") {
      const jdbcFilePath = h2FilePathFromJdbcUrl(config.connection_string);
      const filePath = config.host?.trim() || jdbcFilePath || "";
      if (!filePath) {
        throw new Error(t("connection.h2FilePathRequired"));
      }
      config.host = filePath;
      config.port = 0;
      config.connection_string = isH2SplitJdbcUrl(config.connection_string) ? h2FileJdbcUrlWithPath(config.connection_string, filePath) : h2FileJdbcUrlWithPath(undefined, filePath);
      config.transport_layers = [];
    } else {
      config.host = config.host?.trim() || "127.0.0.1";
      config.port = Number(config.port) || 9092;
      if (h2FilePathFromJdbcUrl(config.connection_string)) {
        config.connection_string = undefined;
      } else {
        config.connection_string = config.connection_string?.trim() || undefined;
      }
    }
  }
  const legacy = config as LegacyConnectionConfig;
  delete legacy.ssh_enabled;
  delete legacy.ssh_host;
  delete legacy.ssh_port;
  delete legacy.ssh_user;
  delete legacy.ssh_password;
  delete legacy.ssh_key_path;
  delete legacy.ssh_key_passphrase;
  delete legacy.ssh_expose_lan;
  delete legacy.ssh_connect_timeout_secs;
  delete legacy.ssh_tunnels;
  delete legacy.proxy_enabled;
  delete legacy.proxy_type;
  delete legacy.proxy_host;
  delete legacy.proxy_port;
  delete legacy.proxy_username;
  delete legacy.proxy_password;
  if (connectionUsesVisibleSchemaFilter(config)) {
    config.visible_databases = undefined;
  } else {
    config.visible_databases = Array.isArray(config.visible_databases) && config.visible_databases.length > 0 ? config.visible_databases : undefined;
  }
  if (config.visible_schemas && Object.keys(config.visible_schemas).length === 0) config.visible_schemas = undefined;
  if (config.agent_java_options && config.agent_java_options.length === 0) config.agent_java_options = undefined;
  return config as ConnectionConfig;
}

function withSavedDatabaseInfo(config: ConnectionConfig, databaseInfo: DatabaseConnectionInfo | null): ConnectionConfig {
  return {
    ...config,
    database_info: databaseInfo ? { ...databaseInfo } : undefined,
  };
}

function connectionConfigSnapshotForVisibleDatabases(): ConnectionConfig {
  return {
    ...(form.value as ConnectionConfig),
    id: editingId.value || "draft",
    visible_databases: form.value.visible_databases,
  };
}

function getUrlParam(params: string | undefined, key: string): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  return parsed.get(key) || "";
}

function sqliteExtensionPathsFromParams(params: string | undefined): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  return [...parsed.getAll("sqlite_extension"), ...parsed.getAll("sqlite_extensions").flatMap((value) => value.split(/\r?\n/))]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function setSqliteExtensionPaths(params: string | undefined, paths: string): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  parsed.delete("sqlite_extension");
  parsed.delete("sqlite_extensions");
  paths
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => parsed.append("sqlite_extension", value));
  return parsed.toString();
}

function setUrlParam(params: string | undefined, key: string, value: string): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  const normalized = value.trim();
  if (normalized) {
    parsed.set(key, normalized);
  } else {
    parsed.delete(key);
  }
  return parsed.toString();
}

function deleteUrlParams(params: string | undefined, keys: string[]): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  for (const key of keys) {
    parsed.delete(key);
  }
  return parsed.toString();
}

function mysqlTlsModeFromParams(params: string | undefined, ssl: boolean | undefined): string {
  const sslMode = getUrlParam(params, "ssl-mode") || getUrlParam(params, "sslmode");
  switch (sslMode.trim().toLowerCase().replace("-", "_")) {
    case "disabled":
    case "disable":
      return "disabled";
    case "preferred":
    case "prefer":
      return "preferred";
    case "required":
    case "require":
      return "required";
    case "verify_ca":
      return "verify_ca";
    case "verify_identity":
      return "verify_identity";
  }

  if (!ssl && getUrlParam(params, "require_ssl").toLowerCase() !== "true") return "disabled";
  if (getUrlParam(params, "verify_identity").toLowerCase() === "true") return "verify_identity";
  if (getUrlParam(params, "verify_ca").toLowerCase() === "true") return "verify_ca";
  return "required";
}

function applyMysqlTlsMode(params: string | undefined, mode: string): string {
  let next = deleteUrlParams(params, ["ssl-mode", "sslmode", "require_ssl", "verify_ca", "verify_identity"]);
  if (mode === "disabled") {
    return setUrlParam(next, "ssl-mode", "disabled");
  }
  if (mode === "preferred") {
    return setUrlParam(next, "ssl-mode", "preferred");
  }

  next = setUrlParam(next, "require_ssl", "true");
  if (mode === "required") {
    next = setUrlParam(next, "verify_ca", "false");
    return setUrlParam(next, "verify_identity", "false");
  }
  if (mode === "verify_ca") {
    next = setUrlParam(next, "verify_ca", "true");
    return setUrlParam(next, "verify_identity", "false");
  }
  next = setUrlParam(next, "verify_ca", "true");
  return setUrlParam(next, "verify_identity", "true");
}

function normalizeRedisSentinelNodes(value: string): string {
  return normalizeRedisNodeList(value);
}

function normalizeRedisClusterNodes(value: string): string {
  return normalizeRedisNodeList(value);
}

function normalizeRedisNodeList(value: string): string {
  return normalizeEndpointLines(value);
}

function normalizeEndpointLines(value: string): string {
  return value
    .split(/[\n,;]+/)
    .map((node) => node.trim())
    .filter(Boolean)
    .join("\n");
}

function firstRedisSentinelEndpoint(value?: string): { host: string; port: number } | null {
  const first = normalizeRedisNodeList(value || "")
    .split("\n")
    .find(Boolean);
  if (!first) return null;
  return parseRedisEndpoint(first, 26379);
}

function firstRedisClusterEndpoint(value?: string): { host: string; port: number } | null {
  const first = normalizeRedisNodeList(value || "")
    .split("\n")
    .find(Boolean);
  if (!first) return null;
  return parseRedisEndpoint(first, 6379);
}

function parseRedisEndpoint(value: string, defaultPort: number): { host: string; port: number } {
  const endpoint = value
    .trim()
    .replace(/^rediss?:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/[/?#].*$/, "");
  if (endpoint.startsWith("[")) {
    const end = endpoint.indexOf("]");
    if (end > 0) {
      const host = endpoint.slice(1, end);
      const portText = endpoint.slice(end + 1).replace(/^:/, "");
      const port = Number(portText);
      return { host, port: Number.isFinite(port) && port > 0 ? port : defaultPort };
    }
  }
  const parts = endpoint.split(":");
  if (parts.length === 2) {
    const port = Number(parts[1]);
    return { host: parts[0], port: Number.isFinite(port) && port > 0 ? port : defaultPort };
  }
  return { host: endpoint, port: defaultPort };
}

function firstEtcdEndpoint(value?: string): { scheme?: string; host: string; port: number } | null {
  const first = normalizeEndpointLines(value || "")
    .split("\n")
    .find(Boolean);
  if (!first) return null;
  return parseEtcdEndpoint(first);
}

function parseEtcdEndpoint(value: string): { scheme?: string; host: string; port: number } {
  const trimmed = value.trim().replace(/^.*@/, "");
  const schemeMatch = trimmed.match(/^(https?):\/\//i);
  const scheme = schemeMatch?.[1].toLowerCase();
  const endpoint = trimmed.replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "");
  if (endpoint.startsWith("[")) {
    const end = endpoint.indexOf("]");
    if (end > 0) {
      const host = endpoint.slice(1, end);
      const portText = endpoint.slice(end + 1).replace(/^:/, "");
      const port = Number(portText);
      return { scheme, host, port: Number.isFinite(port) && port > 0 ? port : 2379 };
    }
  }
  const parts = endpoint.split(":");
  if (parts.length === 2) {
    const port = Number(parts[1]);
    return { scheme, host: parts[0], port: Number.isFinite(port) && port > 0 ? port : 2379 };
  }
  return { scheme, host: endpoint, port: 2379 };
}

function isOracleSysUser(config: Pick<ConnectionConfig, "db_type" | "username">): boolean {
  return config.db_type === "oracle" && config.username.trim().toLowerCase() === "sys";
}

function resetTestState() {
  testRunId += 1;
  isTesting.value = false;
  testResult.value = null;
  clearTestedConnectionInfo();
  showConnectionErrorDialog.value = false;
  connectionErrorDetail.value = "";
}

function resetVisibleDatabaseDraftState() {
  showVisibleDatabasesDialog.value = false;
  isLoadingVisibleDatabases.value = false;
  visibleDatabaseNames.value = [];
  visibleDatabaseSelection.value = new Set();
  visibleDatabaseSearchText.value = "";
  visibleDatabaseError.value = "";
  visibleDatabaseShowSystem.value = false;
}

function resetProductionDatabaseDraftState() {
  showProductionDatabasesDialog.value = false;
  isLoadingProductionDatabases.value = false;
  productionDatabaseNames.value = [];
  productionDatabaseSelection.value = new Set();
  productionDatabaseSearchText.value = "";
  productionDatabaseError.value = "";
  productionProtectionEnabled.value = false;
}

/** Silently load database names so the summary count shows a real total. */
async function preloadVisibleDatabaseNames() {
  if (!ensureConnectionHostResolvedFromUrl()) return;
  if (visibleDatabaseNames.value.length > 0) return;
  isLoadingVisibleDatabases.value = true;
  const draftId = buildDraftVisibleDatabasesConnectionId(uuid());
  try {
    const draftConfig = {
      ...connectionConfigForSubmit(draftId),
      id: draftId,
      one_time: true,
    };
    await api.connectDb(draftConfig);
    visibleDatabaseNames.value = await loadVisibleDatabaseNames(draftId, draftConfig);
  } catch {
    // silently fail
  } finally {
    await api.disconnectDb(draftId).catch(() => undefined);
    isLoadingVisibleDatabases.value = false;
  }
}

async function openVisibleDatabasesPicker() {
  if (!ensureConnectionHostResolvedFromUrl()) return;
  if (!canChooseVisibleDatabases.value || isLoadingVisibleDatabases.value) return;

  isLoadingVisibleDatabases.value = true;
  visibleDatabaseError.value = "";
  visibleDatabaseSearchText.value = "";
  const draftId = buildDraftVisibleDatabasesConnectionId(uuid());

  try {
    const draftConfig = {
      ...connectionConfigForSubmit(draftId),
      id: draftId,
      one_time: true,
    };
    await api.connectDb(draftConfig);
    const names = await loadVisibleDatabaseNames(draftId, draftConfig);
    visibleDatabaseNames.value = names;
    const configuredSchemas = visibleSchemaObjectSelection.value;
    const initialSelection = visibleFilterUsesSchemas.value ? (Array.isArray(configuredSchemas) ? normalizeVisibleSchemaSelection(configuredSchemas, names) : names) : initialVisibleDatabaseSelection(names, form.value.visible_databases, draftConfig);
    visibleDatabaseSelection.value = new Set(initialSelection);
    visibleDatabaseShowSystem.value = !visibleFilterUsesSchemas.value && initialSelection.some((database) => isSystemDatabaseName(draftConfig.db_type, database));
    showVisibleDatabasesDialog.value = true;
  } catch (e: any) {
    visibleDatabaseNames.value = [];
    visibleDatabaseSelection.value = new Set();
    visibleDatabaseError.value = mongodbAuthFailureHint(errorMessage(e));
    testResult.value = { ok: false, message: visibleDatabaseError.value };
    showVisibleDatabasesDialog.value = true;
  } finally {
    await api.disconnectDb(draftId).catch(() => undefined);
    isLoadingVisibleDatabases.value = false;
  }
}

async function loadVisibleDatabaseNames(connectionId: string, config: ConnectionConfig): Promise<string[]> {
  if (connectionUsesVisibleSchemaFilter(config)) {
    return api.listSchemas(connectionId, config.database || "");
  }
  if (config.db_type === "redis") {
    return (await api.redisListDatabases(connectionId)).map((database) => String(database.db));
  }
  if (config.db_type === "mongodb") {
    return api.mongoListDatabases(connectionId);
  }
  return (await api.listDatabases(connectionId)).map((database) => database.name);
}

function normalizeProductionDatabaseSelection(selectedNames: Iterable<string>, databaseNames: string[]): string[] {
  const available = new Map(databaseNames.map((name) => [name.toLowerCase(), name]));
  const selected = new Set<string>();
  for (const name of selectedNames) {
    const canonicalName = available.get(name.toLowerCase());
    if (canonicalName) selected.add(canonicalName);
  }
  return [...selected];
}

function initialProductionDatabaseSelection(databaseNames: string[]): string[] {
  const configured = form.value.production_databases || [];
  // A new database-level safeguard starts broad; users can explicitly narrow it in the picker.
  return configured.length ? normalizeProductionDatabaseSelection(configured, databaseNames) : databaseNames;
}

async function loadProductionDatabaseNames(connectionId: string, config: ConnectionConfig): Promise<string[]> {
  if (config.db_type === "redis") {
    return (await api.redisListDatabases(connectionId)).map((database) => String(database.db));
  }
  if (config.db_type === "mongodb") {
    return api.mongoListDatabases(connectionId);
  }
  return (await api.listDatabases(connectionId)).map((database) => database.name);
}

async function openProductionDatabasesPicker() {
  if (!ensureConnectionHostResolvedFromUrl() || !productionProtectionEnabled.value || form.value.is_production || isLoadingProductionDatabases.value) return;
  showProductionDatabasesDialog.value = true;
  await reloadProductionDatabases();
}

async function reloadProductionDatabases() {
  if (isLoadingProductionDatabases.value) return;

  isLoadingProductionDatabases.value = true;
  productionDatabaseError.value = "";
  productionDatabaseSearchText.value = "";
  const draftId = `__production_database_draft_${uuid()}`;
  try {
    const draftConfig = {
      ...connectionConfigForSubmit(draftId),
      id: draftId,
      one_time: true,
    };
    await api.connectDb(draftConfig);
    productionDatabaseNames.value = await loadProductionDatabaseNames(draftId, draftConfig);
    productionDatabaseSelection.value = new Set(initialProductionDatabaseSelection(productionDatabaseNames.value));
  } catch (e: any) {
    productionDatabaseNames.value = [];
    productionDatabaseSelection.value = new Set();
    productionDatabaseError.value = mongodbAuthFailureHint(errorMessage(e));
  } finally {
    await api.disconnectDb(draftId).catch(() => undefined);
    isLoadingProductionDatabases.value = false;
  }
}

function toggleProductionDatabase(database: string) {
  const next = new Set(productionDatabaseSelection.value);
  if (next.has(database)) next.delete(database);
  else next.add(database);
  productionDatabaseSelection.value = next;
}

function selectAllProductionDatabases() {
  productionDatabaseSelection.value = new Set(productionDatabaseNames.value);
}

function clearProductionDatabaseSelection() {
  productionDatabaseSelection.value = new Set();
}

function saveProductionDatabaseSelection() {
  if (!productionDatabaseCanSave.value) return;
  // A database selection is always narrower than a connection-wide marker.
  productionProtectionEnabled.value = true;
  form.value.is_production = false;
  form.value.production_databases = normalizeProductionDatabaseSelection(productionDatabaseSelection.value, productionDatabaseNames.value);
  showProductionDatabasesDialog.value = false;
}

function toggleVisibleDatabase(database: string) {
  const next = new Set(visibleDatabaseSelection.value);
  if (next.has(database)) next.delete(database);
  else next.add(database);
  visibleDatabaseSelection.value = next;
}

function selectAllVisibleDatabases() {
  visibleDatabaseSelection.value = new Set(listedVisibleDatabaseNames.value);
}

function clearVisibleDatabaseSelection() {
  visibleDatabaseSelection.value = new Set();
}

function showAllVisibleDatabases() {
  if (visibleFilterUsesSchemas.value) {
    handleDraftSchemasShowAll();
    form.value.visible_databases = undefined;
  } else {
    form.value.visible_databases = undefined;
  }
  visibleDatabaseSelection.value = new Set();
  visibleDatabaseNames.value = [];
  showVisibleDatabasesDialog.value = false;
}

function saveVisibleDatabaseSelection() {
  if (!visibleDatabaseCanSave.value) return;
  if (visibleFilterUsesSchemas.value) {
    const key = visibleSchemasDatabaseKey.value;
    form.value.visible_databases = undefined;
    form.value.visible_schemas = {
      ...form.value.visible_schemas,
      [key]: normalizeVisibleSchemaSelection([...visibleDatabaseSelection.value], visibleDatabaseNames.value),
    };
  } else {
    form.value.visible_databases = normalizeVisibleDatabaseSelection([...visibleDatabaseSelection.value], visibleDatabaseNames.value);
  }
  showVisibleDatabasesDialog.value = false;
}

function resetVisibleSchemasState() {
  showVisibleSchemasDialog.value = false;
  isLoadingVisibleSchemas.value = false;
  visibleSchemaNames.value = [];
  visibleSchemaInitialSelection.value = [];
  visibleSchemaError.value = "";
}

async function openVisibleSchemasPicker() {
  if (!ensureConnectionHostResolvedFromUrl()) return;
  if (!canChooseVisibleSchemas.value || isLoadingVisibleSchemas.value) return;
  isLoadingVisibleSchemas.value = true;
  visibleSchemaError.value = "";
  const draftId = buildDraftVisibleSchemasConnectionId(uuid());
  try {
    const draftConfig: ConnectionConfig = {
      ...connectionConfigForSubmit(draftId),
      id: draftId,
    };
    await store.addEphemeralConnection(draftConfig);
    await store.ensureConnected(draftId);
    const names = await api.listSchemas(draftId, visibleSchemasDatabaseKey.value);
    visibleSchemaNames.value = names;
    const key = visibleSchemasDatabaseKey.value;
    const configured = form.value.visible_schemas?.[key];
    visibleSchemaInitialSelection.value = Array.isArray(configured) ? configured : [];
    showVisibleSchemasDialog.value = true;
  } catch (e: any) {
    visibleSchemaNames.value = [];
    visibleSchemaInitialSelection.value = [];
    visibleSchemaError.value = String(e?.message || e);
  } finally {
    isLoadingVisibleSchemas.value = false;
    store.removeConnection(draftId).catch(() => {});
  }
}

function handleDraftSchemasSave(selectedNames: string[]) {
  const key = visibleSchemasDatabaseKey.value;
  form.value.visible_schemas = { ...form.value.visible_schemas, [key]: selectedNames };
}

function handleDraftSchemasShowAll() {
  const key = visibleSchemasDatabaseKey.value;
  if (form.value.visible_schemas) {
    const next = { ...form.value.visible_schemas };
    delete next[key];
    form.value.visible_schemas = Object.keys(next).length > 0 ? next : undefined;
  }
}

function applyConnectionUrl() {
  if (applyConnectionUrlToForm(connectionUrlInput.value)) {
    toast(t("connection.parseConnectionUrlApplied"), 2000);
  }
}

async function copyTestResult() {
  if (!testResultMessage.value) return;
  try {
    await copyToClipboard(testResultMessage.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyDatabaseInfo() {
  const info = visibleDatabaseInfo.value;
  if (!info) return;
  try {
    await copyToClipboard(databaseInfoCopyText(info, databaseInfoFieldLabel, databaseIdentifierCaseLabel));
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyAgentInstallError() {
  if (!agentInstallError.value) return;
  try {
    await copyToClipboard(agentInstallError.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyConnectionErrorDetail() {
  if (!connectionErrorDetail.value) return;
  try {
    await copyToClipboard(connectionErrorDetail.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function openJdbcDriverManagerFromError() {
  showConnectionErrorDialog.value = false;
  emit("openDriverStore", { target: "tab", tab: "jdbc" });
}

function resetForm() {
  editingId.value = null;
  form.value = defaultForm();
  selectedTransportLayerId.value = null;
  draggedTransportLayerId.value = null;
  selectedType.value = "mysql";
  customDriverName.value = "";
  mongoUseUrl.value = false;
  resetMqFields();
  oceanbaseSubMode.value = "mysql";
  dremioConnectionMode.value = "legacy";
  resetDremioConnectionUrls();
  jdbcDriverPathsInput.value = "";
  selectedJdbcDriverPath.value = "";
  connectionUrlInput.value = "";
  appliedConnectionUrlInput.value = "";
  dialogStep.value = "select";
  dbPickerView.value = "icon";
  dbSearchQuery.value = "";
  configTab.value = "connection";
  resetVisibleDatabaseDraftState();
  resetProductionDatabaseDraftState();
  resetVisibleSchemasState();
  resetTestState();
}

const submittedOneTimePrefillKey = ref<string | null>(null);

function oneTimePrefillKey(draft: ConnectionDeepLinkDraft) {
  return JSON.stringify([draft.name, draft.dbType, draft.driverProfile, draft.driverLabel, draft.host, draft.port, draft.portExplicit, draft.username, draft.password, draft.database, draft.urlParams, draft.ssl, draft.connectionString, draft.oracleConnectionType, draft.useMongoUrl]);
}

function submitOneTimePrefill(draft: ConnectionDeepLinkDraft) {
  if (!draft.oneTime) return;
  const key = oneTimePrefillKey(draft);
  if (submittedOneTimePrefillKey.value === key) return;
  submittedOneTimePrefillKey.value = key;
  void nextTick(() => save());
}

function applyConnectionDraftToConfig(config: Omit<ConnectionConfig, "id">, draft: ConnectionDeepLinkDraft): Omit<ConnectionConfig, "id"> {
  const next = {
    ...config,
    db_type: draft.dbType,
    driver_profile: draft.driverProfile,
    driver_label: draft.driverLabel,
    host: draft.host ?? config.host,
    port: draft.port ?? config.port,
    username: draft.username ?? config.username,
    password: draft.password ?? config.password,
    database: draft.database ?? config.database,
    url_params: draft.urlParams ?? config.url_params,
    ssl: draft.ssl ?? config.ssl,
    connection_string: draft.connectionString ?? config.connection_string,
    oracle_connection_type: draft.oracleConnectionType ?? config.oracle_connection_type,
    one_time: draft.oneTime || undefined,
  };
  setSqlServerPortExplicit(next, draft.portExplicit === true);
  return next;
}

function applyConnectionDraftToForm(draft: ConnectionDeepLinkDraft) {
  applyProfile(draft.driverProfile);
  form.value = applyConnectionDraftToConfig(form.value, draft);
  selectedType.value = draft.driverProfile;
  if (form.value.db_type === "h2") {
    h2ConnectionMode.value = h2ConnectionModeForConfig(form.value);
  }
  if (draft.driverProfile === "oceanbase-oracle") {
    oceanbaseSubMode.value = "oracle";
    selectedType.value = "oceanbase";
  }
  if (draft.driverProfile === "gbase8a" || draft.driverProfile === "gbase8s") {
    selectedType.value = "gbase";
  }
  customDriverName.value = isCustomCompatibleProfile() ? draft.driverLabel : "";
  mongoUseUrl.value = !!draft.useMongoUrl;
  if (draft.name?.trim()) {
    form.value.name = draft.name.trim();
  } else if (!form.value.name.trim()) {
    form.value.name = draft.database || draft.host || draft.driverLabel;
  }
  dialogStep.value = "config";
  configTab.value = "connection";
  resetTestState();
}

function applyConnectionPrefill(draft: ConnectionDeepLinkDraft) {
  resetForm();
  applyConnectionDraftToForm(draft);
  submitOneTimePrefill(draft);
}

watch(
  open,
  (value) => {
    if (!value) {
      const draftId = editingId.value ? null : draftTestConnectionId.value;
      submittedOneTimePrefillKey.value = null;
      resetForm();
      if (draftId) {
        void api.disconnectDb(draftId).catch(() => undefined);
        draftTestConnectionId.value = uuid();
      }
      return;
    }
    if (!props.editConfig) {
      resetForm();
      if (props.prefillConfig) applyConnectionPrefill(props.prefillConfig);
    }
    if (!props.prefillConfig?.oneTime) {
      void loadJdbcDrivers();
      void loadAgentDrivers();
      void loadSshConfigHosts();
    }
    // Preload database names so the summary count is accurate right away.
    void nextTick(() => {
      if (canChooseVisibleDatabases.value && hasVisibleDatabaseFilter.value) {
        void preloadVisibleDatabaseNames();
      }
    });
  },
  { immediate: true },
);

watch(
  () => props.prefillConfig,
  (draft) => {
    if (open.value && draft && !props.editConfig) applyConnectionPrefill(draft);
  },
);

watch([() => form.value.db_type, () => form.value.username], () => {
  if (isOracleSysUser(form.value)) form.value.sysdba = true;
});

watch(
  () => connectionConfigSnapshotForVisibleDatabases(),
  (current, previous) => {
    if (!previous || !form.value.visible_databases?.length) return;
    if (!visibleDatabaseSelectionIsStale(previous, current)) return;
    form.value.visible_databases = undefined;
    visibleDatabaseNames.value = [];
    visibleDatabaseSelection.value = new Set();
  },
);

watch(visibleDatabaseShowSystem, (show) => {
  if (show) return;
  const connection = connectionConfigSnapshotForVisibleDatabases();
  visibleDatabaseSelection.value = new Set([...visibleDatabaseSelection.value].filter((database) => !isSystemDatabaseName(connection.db_type, database)));
});

watch(canUseTransportLayers, (value) => {
  if (!value && configTab.value === "transport") {
    configTab.value = "connection";
  }
});

watch(supportsTlsToggle, (value) => {
  if (!value && configTab.value === "tls") {
    configTab.value = "connection";
  }
});

function ensureSelectedTransportLayer() {
  if (!selectedTransportLayerId.value || !transportLayers.value.some((layer) => layer.id === selectedTransportLayerId.value)) {
    selectedTransportLayerId.value = transportLayers.value[0]?.id || null;
  }
}

function addSshTunnel() {
  const next: TransportLayerConfig = { type: "ssh", ...defaultSshTunnel() };
  next.name = t("connection.sshHopDefaultName", { index: transportLayers.value.length + 1 });
  form.value.transport_layers = [...transportLayers.value, next];
  selectedTransportLayerId.value = next.id;
  resetTestState();
}

function addProxyTunnel() {
  const next: TransportLayerConfig = { type: "proxy", ...defaultProxyTunnel() };
  next.name = `Proxy ${transportLayers.value.length + 1}`;
  form.value.transport_layers = [...transportLayers.value, next];
  selectedTransportLayerId.value = next.id;
  resetTestState();
}

function addHttpTunnel() {
  const next: TransportLayerConfig = { type: "http_tunnel", ...defaultHttpTunnel() };
  next.name = t("connection.httpTunnelDefaultName", { index: 1 });
  form.value.transport_layers = [next, ...transportLayers.value];
  selectedTransportLayerId.value = next.id;
  resetTestState();
}

function duplicateTransportLayer(layer: TransportLayerConfig) {
  const next = normalizeTransportLayer({ ...layer, id: uuid(), name: layer.name ? `${layer.name} copy` : "" });
  form.value.transport_layers = [...transportLayers.value, next];
  selectedTransportLayerId.value = next.id;
  resetTestState();
}

function removeTransportLayer(id: string) {
  form.value.transport_layers = transportLayers.value.filter((layer) => layer.id !== id);
  ensureSelectedTransportLayer();
  resetTestState();
}

function moveTransportLayer(id: string, direction: -1 | 1) {
  const layers = [...transportLayers.value];
  const index = layers.findIndex((layer) => layer.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= layers.length) return;
  [layers[index], layers[target]] = [layers[target], layers[index]];
  form.value.transport_layers = layers;
  resetTestState();
}

function dropTransportLayer(targetId: string) {
  const sourceId = draggedTransportLayerId.value;
  draggedTransportLayerId.value = null;
  if (!sourceId || sourceId === targetId) return;
  const layers = [...transportLayers.value];
  const sourceIndex = layers.findIndex((layer) => layer.id === sourceId);
  const targetIndex = layers.findIndex((layer) => layer.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [source] = layers.splice(sourceIndex, 1);
  layers.splice(targetIndex, 0, source);
  form.value.transport_layers = layers;
  resetTestState();
}

function changeSelectedTransportLayerType(type: "ssh" | "proxy" | "http_tunnel") {
  const selected = selectedTransportLayer.value;
  if (!selected || selected.type === type) return;
  const replacement: TransportLayerConfig =
    type === "proxy" ? { type: "proxy", ...defaultProxyTunnel(), id: selected.id, name: selected.name } : type === "http_tunnel" ? { type: "http_tunnel", ...defaultHttpTunnel(), id: selected.id, name: selected.name } : { type: "ssh", ...defaultSshTunnel(), id: selected.id, name: selected.name };
  form.value.transport_layers = transportLayers.value.map((layer) => (layer.id === selected.id ? replacement : layer));
  resetTestState();
}

function updateSelectedProxyType(value: unknown) {
  const layer = selectedProxyLayer.value;
  if (!layer) return;
  layer.proxy_type = value === "http" ? "http" : "socks5";
  resetTestState();
}

/**
 * "agent" is legacy-only: it's never chosen from this dropdown, only ever
 * inherited from a connection saved before this selector existed. Once the
 * user picks something else, the option (and its underlying checkbox) is
 * gone from the form for good.
 */
function isLegacySshAgentMethod(hop: Partial<SshTunnelConfig> | null | undefined) {
  return hop?.auth_method === "agent";
}

function updateSelectedSshAuthMethod(value: unknown) {
  const layer = selectedSshLayer.value;
  if (!layer) return;
  layer.auth_method = value === "key" ? "key" : value === "none" ? "none" : "password";
  // Scrub credential fields that do not apply to the selected method so
  // they are not accidentally submitted or used by the backend fallback.
  if (layer.auth_method !== "password") layer.password = "";
  if (layer.auth_method !== "key") {
    layer.key_path = "";
    layer.key_passphrase = "";
  }
  if (layer.auth_method !== "key") {
    layer.use_ssh_agent = false;
  }
  resetTestState();
}

function validateTransportLayers(config: LegacyConnectionConfig) {
  const layers = config.transport_layers || [];
  layers.forEach((layer, index) => {
    if (layer.enabled === false) return;
    // Profile-referencing layers are stubs: the shared profile supplies the
    // whole configuration at connect time, so there is nothing to validate.
    if (layer.profile_id) return;
    const label = layer.name?.trim() || transportLayerDefaultName(layer, index);
    if (layer.type === "http_tunnel") {
      if (index !== 0) throw new Error(t("connection.httpTunnelInvalidOrder", { hop: label }));
      if (!layer.url?.trim()) throw new Error(t("connection.httpTunnelInvalidUrl", { hop: label }));
      const timeout = Number(layer.connect_timeout_secs);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) {
        throw new Error(t("connection.httpTunnelInvalidTimeout", { hop: label }));
      }
      return;
    }
    if (!layer.host?.trim()) throw new Error(t("connection.sshHopInvalidHost", { hop: label }));
    const port = Number(layer.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(t("connection.sshHopInvalidPort", { hop: label }));
    }
    if (layer.type === "ssh") {
      layer.user = layer.user?.trim() || DEFAULT_SSH_USER;
      // Auth credentials are optional: the backend probes "none" authentication
      // first, so hops that require no credential (e.g. passwordless SSH proxies)
      // are valid with password, key, and agent all left empty.
      const timeout = Number(layer.connect_timeout_secs);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) {
        throw new Error(t("connection.sshHopInvalidTimeout", { hop: label }));
      }
    }
  });
}

async function save() {
  if (!ensureConnectionHostResolvedFromUrl()) return;
  if (isSaving.value) return;
  const databaseInfoForSave = visibleTestDatabaseInfo.value ?? visibleSavedDatabaseInfo.value;
  isSaving.value = true;
  try {
    if (editingId.value) {
      const updated = withSavedDatabaseInfo(connectionConfigForSubmit(editingId.value), databaseInfoForSave);
      await ensureRequiredAgentDriverInstalled(updated);
      await store.updateConnection(updated);
      store.stopEditing();
    } else {
      const config = withSavedDatabaseInfo(connectionConfigForSubmit(draftTestConnectionId.value), databaseInfoForSave);
      await ensureRequiredAgentDriverInstalled(config);
      await store.addConnection(config);
      draftTestConnectionId.value = uuid();
      if (config.db_type === "jdbc") {
        open.value = false;
        return;
      }
      open.value = false;
      await nextTick();
      emit("connectStarted", config.name);
      void store
        .connect(config)
        .then(() => {
          emit("connectSucceeded", config.name);
        })
        .catch((e: any) => {
          const message = String(e?.message || e);
          if (message.includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE)) return;
          if (config.one_time) void store.removeConnection(config.id);
          emit("connectFailed", appendConnectionErrorHints(config, mongodbAuthFailureHint(message), t));
        });
      return;
    }
    open.value = false;
  } catch (e: any) {
    const message = mongodbAuthFailureHint(String(e?.message || e));
    testResult.value = { ok: false, message };
    showConnectionError(message);
  } finally {
    isSaving.value = false;
  }
}

const dialogTitle = ref("");
watch([() => editingId.value, () => open.value], () => {
  dialogTitle.value = editingId.value ? t("connection.editTitle") : t("connection.title");
});

const sshConfigHostAliases = computed(() => sshConfigHosts.value.map((entry) => entry.alias));

function applySshConfigHostAliasPrefill(target: SshTunnelConfig) {
  prefillSshConfigHostAlias(target, sshConfigHosts.value);
}

async function browseSshKeyPath(target?: SshTunnelConfig | null) {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "Select SSH Private Key",
      multiple: false,
    });
    if (selected && typeof selected === "string") {
      if (target) {
        target.key_path = selected;
      }
    }
  }
}

async function browseCaCertPath() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "Select CA Certificate",
      multiple: false,
      filters: [{ name: "Certificate", extensions: ["crt", "cer", "pem"] }],
    });
    if (selected && typeof selected === "string") {
      form.value.ca_cert_path = selected;
    }
  }
}

async function browseMysqlTlsFile(target: "cert" | "key") {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: target === "cert" ? t("connection.mysqlClientCertBrowse") : t("connection.mysqlClientKeyBrowse"),
      multiple: false,
      filters: [
        { name: "PEM", extensions: ["pem", "crt", "cer", "key"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (selected && typeof selected === "string") {
      if (target === "cert") {
        mysqlClientCertPath.value = selected;
      } else {
        mysqlClientKeyPath.value = selected;
      }
    }
  }
}

async function browsePostgresTlsFile(target: "root" | "cert" | "key") {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: target === "root" ? t("connection.postgresRootCertBrowse") : target === "cert" ? t("connection.postgresClientCertBrowse") : t("connection.postgresClientKeyBrowse"),
      multiple: false,
      filters: [
        { name: "PEM", extensions: ["pem", "crt", "cer", "key"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (selected && typeof selected === "string") {
      if (target === "root") {
        postgresRootCertPath.value = selected;
      } else if (target === "cert") {
        postgresClientCertPath.value = selected;
      } else {
        postgresClientKeyPath.value = selected;
      }
    }
  }
}

async function browseEtcdTlsFile(target: "ca" | "cert" | "key") {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: target === "ca" ? t("connection.etcdCaCertBrowse") : target === "cert" ? t("connection.etcdClientCertBrowse") : t("connection.etcdClientKeyBrowse"),
      multiple: false,
      filters: [
        { name: "PEM", extensions: ["pem", "crt", "cer", "key"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (selected && typeof selected === "string") {
      if (target === "ca") {
        form.value.ca_cert_path = selected;
      } else if (target === "cert") {
        form.value.client_cert_path = selected;
      } else {
        form.value.client_key_path = selected;
      }
    }
  }
}

async function browseHiveKerberosFile(target: "krb5" | "jaas") {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: target === "krb5" ? t("connection.hiveKrb5ConfBrowse") : t("connection.hiveJaasConfigBrowse"),
      multiple: false,
      filters: [{ name: "Config", extensions: ["conf", "ini", "properties", "*"] }],
    });
    if (selected && typeof selected === "string") {
      if (target === "krb5") {
        hiveKrb5ConfPath.value = selected;
      } else {
        hiveJaasConfigPath.value = selected;
      }
    }
  }
}

async function browseKafkaKerberosFile(target: "keytab" | "krb5") {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: target === "keytab" ? t("connection.kafkaKerberosKeytabBrowse") : t("connection.kafkaKerberosKrb5ConfBrowse"),
      multiple: false,
      filters: [{ name: "Kerberos", extensions: target === "keytab" ? ["keytab", "kt", "*"] : ["conf", "ini", "*"] }],
    });
    if (selected && typeof selected === "string") {
      if (target === "keytab") {
        mqKafkaKerberosKeytabPath.value = selected;
      } else {
        mqKafkaKrb5ConfPath.value = selected;
      }
    }
  }
}

async function browseDbFilePath() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filters = form.value.db_type === "duckdb" ? [{ name: "DuckDB", extensions: ["duckdb", "db"] }] : form.value.db_type === "access" ? [{ name: "Microsoft Access", extensions: ["accdb", "mdb"] }] : form.value.db_type === "h2" ? [{ name: "H2", extensions: ["db"] }] : undefined;
    const selected = await open({
      title: "Select Database File",
      multiple: false,
      ...(filters ? { filters } : {}),
    });
    if (selected && typeof selected === "string") {
      form.value.host = selected;
    }
  }
}

async function browseSqliteExtensionPath() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: t("connection.sqliteExtensionBrowse"),
      multiple: true,
      filters: [
        { name: "SQLite Extension", extensions: ["dylib", "so", "dll"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    const selectedPaths = Array.isArray(selected) ? selected : selected && typeof selected === "string" ? [selected] : [];
    if (selectedPaths.length) {
      const existing = sqliteExtensionPaths.value
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean);
      sqliteExtensionPaths.value = [...existing, ...selectedPaths].join("\n");
    }
  }
}

function ensureDuckDbFileExtension(path: string): string {
  return /\.(duckdb|db)$/i.test(path) ? path : `${path}.duckdb`;
}

async function createDuckDbFilePath() {
  if (!isTauriRuntime()) return;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: t("connection.createDuckDbFile"),
    defaultPath: "database.duckdb",
    filters: [{ name: "DuckDB", extensions: ["duckdb", "db"] }],
  });
  if (!selected) return;

  const path = ensureDuckDbFileExtension(selected);
  form.value.host = path;

  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, "");
  } catch (e) {
    console.error("Failed to create DuckDB file:", e);
  }
}

function ensureSqliteFileExtension(path: string): string {
  const extensionPattern = new RegExp(`\\.(${SQLITE_DATABASE_FILE_EXTENSIONS.join("|")})$`, "i");
  return extensionPattern.test(path) ? path : `${path}.db`;
}

async function createSqliteFilePath() {
  if (!isTauriRuntime()) return;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: t("connection.createSqliteFile"),
    defaultPath: "database.db",
    filters: [{ name: "SQLite", extensions: SQLITE_DATABASE_FILE_EXTENSIONS }],
  });
  if (!selected) return;

  const path = ensureSqliteFileExtension(selected);
  form.value.host = path;

  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, "");
  } catch (e) {
    console.error("Failed to create SQLite file:", e);
  }
}

async function browseJdbcDriverPaths() {
  if (!isTauriRuntime()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("connection.jdbcDriverBrowse"),
    multiple: true,
    filters: [{ name: "JDBC Driver", extensions: ["jar"] }],
  });
  if (!selected) return;

  const paths = Array.isArray(selected) ? selected : [selected];
  const existing = jdbcDriverPathsInput.value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...paths.filter((path): path is string => typeof path === "string")]));
  jdbcDriverPathsInput.value = merged.join("\n");
}

async function loadJdbcDrivers() {
  if (!isDesktop) return;
  try {
    const [drivers, bundles, localBundles] = await Promise.all([api.listJdbcDrivers(), api.listJdbcMavenBundles(), api.listJdbcLocalBundles()]);
    jdbcDrivers.value = drivers;
    jdbcMavenBundles.value = bundles;
    jdbcLocalBundles.value = localBundles;
    applyPrestoSqlBuiltinDriverPathsIfAvailable();
  } catch {
    jdbcDrivers.value = [];
    jdbcMavenBundles.value = [];
    jdbcLocalBundles.value = [];
  }
}

async function loadSshConfigHosts() {
  try {
    sshConfigHosts.value = await api.listSshConfigHosts();
  } catch {
    sshConfigHosts.value = [];
  }
}

async function loadAgentDrivers() {
  try {
    agentDrivers.value = await api.listInstalledAgentsLocal();
    if (!settingsStore.editorSettings.updateNotificationsEnabled) return;
    api
      .listInstalledAgents()
      .then((drivers) => {
        agentDrivers.value = drivers;
      })
      .catch(() => {
        /* keep local state */
      });
  } catch {
    agentDrivers.value = [];
  }
}

function addJdbcDriverPaths(paths: string[]) {
  const existing = jdbcDriverPathsInput.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  jdbcDriverPathsInput.value = Array.from(new Set([...existing, ...paths])).join("\n");
}

function applyPrestoSqlBuiltinDriverPathsIfAvailable() {
  if (form.value.db_type !== "prestosql" || jdbcManualClasspathCount.value > 0) return;
  const paths = prestoSqlBuiltinDriverPaths(jdbcMavenBundles.value);
  if (paths.length === 0) return;
  addJdbcDriverPaths(paths);
  selectedJdbcDriverPath.value = jdbcDriverSelectItems.value.find((item) => paths.every((path) => item.paths.includes(path)))?.id ?? "";
  jdbcManualClasspathOpen.value = false;
}

function onJdbcDriverSelect(id: any) {
  if (typeof id !== "string" || !id) return;
  const item = jdbcDriverSelectItemById.value.get(id);
  if (!item) return;
  selectedJdbcDriverPath.value = id;
  if (isJdbcxConnection.value && item.jdbcxRuntime) {
    const installedJdbcxRuntimePaths = new Set(jdbcDriverSelectItems.value.filter((candidate) => candidate.jdbcxRuntime).flatMap((candidate) => candidate.paths));
    const existingPaths = jdbcDriverPathsInput.value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter((path) => path && !installedJdbcxRuntimePaths.has(path));
    jdbcDriverPathsInput.value = Array.from(new Set([...existingPaths, ...item.paths])).join("\n");
  } else {
    addJdbcDriverPaths(item.paths);
  }
  jdbcManualClasspathOpen.value = false;
}

onMounted(async () => {
  void tunnelProfileStore.init();
  unlistenAgentInstallProgress = await api.listenAgentInstallProgress(handleAgentInstallProgress);
});

onUnmounted(() => {
  unlistenAgentInstallProgress?.();
  unlistenAgentInstallProgress = null;
});

function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="connection-dialog-content" :class="connectionDialogContentClass" :data-wide="shouldUseWideConnectionDialog ? 'true' : undefined" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ editingId ? t("connection.editTitle") : t("connection.title") }}</DialogTitle>
      </DialogHeader>

      <template v-if="dialogStep === 'select'">
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-2">
              <div class="flex shrink-0 rounded-lg border bg-muted/40 p-0.5">
                <Button type="button" size="icon-sm" :variant="dbPickerView === 'icon' ? 'secondary' : 'ghost'" :title="t('connection.iconView')" :aria-label="t('connection.iconView')" @click="dbPickerView = 'icon'">
                  <Grid3X3 class="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="icon-sm" :variant="dbPickerView === 'list' ? 'secondary' : 'ghost'" :title="t('connection.listView')" :aria-label="t('connection.listView')" @click="dbPickerView = 'list'">
                  <List class="h-3.5 w-3.5" />
                </Button>
              </div>
              <div class="relative w-full sm:w-64">
                <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="dbSearchQuery" class="h-9 pl-8" :placeholder="t('connection.searchDatabasePlaceholder')" />
              </div>
            </div>
            <Button data-jdbc-connection-entry type="button" variant="outline" class="h-9 shrink-0 gap-2" @click="goToConnectionStep('jdbc')">
              <DatabaseIcon db-type="jdbc" class="h-4 w-4" />
              {{ t("connection.jdbcConnection") }}
            </Button>
          </div>

          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
            <section v-for="category in filteredDbCategories" :key="category.key" class="space-y-2">
              <div class="flex items-center">
                <h3 v-if="category.title" class="text-sm font-medium">{{ category.title }}</h3>
              </div>

              <div v-if="dbPickerView === 'icon'" class="connection-db-picker-grid grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                <button
                  v-for="opt in category.options"
                  :key="opt.value"
                  type="button"
                  class="connection-db-picker-option group flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border bg-background/70 p-3 text-center transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="selectedType === opt.value ? 'connection-db-picker-option--selected shadow-sm' : 'border-border'"
                  :aria-pressed="selectedType === opt.value"
                  @click="onDbTypeChange(opt.value)"
                  @dblclick="goToConnectionStep(opt.value)"
                >
                  <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 transition group-hover:bg-background">
                    <DatabaseIcon :db-type="iconTypeMap[opt.value]" class="h-6 w-6" />
                  </span>
                  <span class="max-w-full truncate text-sm font-medium">{{ opt.label }}</span>
                </button>
              </div>

              <div v-else class="grid gap-2">
                <button
                  v-for="opt in category.options"
                  :key="opt.value"
                  type="button"
                  class="connection-db-picker-option flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left transition hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="selectedType === opt.value ? 'connection-db-picker-option--selected' : 'border-border'"
                  :aria-pressed="selectedType === opt.value"
                  @click="onDbTypeChange(opt.value)"
                  @dblclick="goToConnectionStep(opt.value)"
                >
                  <DatabaseIcon :db-type="iconTypeMap[opt.value]" class="h-5 w-5 shrink-0" />
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ opt.label }}</span>
                  <span class="text-xs text-muted-foreground">{{ category.title }}</span>
                </button>
              </div>
            </section>

            <div v-if="!hasDbPickerResults" class="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              {{ t("connection.noDatabaseMatches") }}
            </div>
          </div>
        </div>

        <DialogFooter class="flex shrink-0 items-center gap-2">
          <div class="mr-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
            <span class="truncate">{{ t("connection.selectedDatabase") }}: {{ selectedProfile().label }}</span>
          </div>
          <Button :disabled="!hasDbPickerResults" @click="goToConnectionStep()">
            {{ t("connection.next") }}
            <ChevronRight class="h-4 w-4" />
          </Button>
        </DialogFooter>
      </template>

      <template v-else>
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <Tabs v-model="configTab" class="flex min-h-0 flex-1 flex-col">
            <div class="flex items-center justify-between border-b pb-2">
              <TabsList>
                <TabsTrigger value="connection">{{ t("connection.basicTab") }}</TabsTrigger>
                <TabsTrigger v-if="supportsTlsToggle" value="tls">{{ t("connection.tlsTab") }}</TabsTrigger>
                <TabsTrigger v-if="canUseTransportLayers" value="transport">{{ t("connection.sshTunnel") }}</TabsTrigger>
                <TabsTrigger value="advanced">{{ t("connection.advancedTab") }}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="connection" class="m-0 min-h-0 flex-1 overflow-hidden">
              <div class="connection-form-body grid h-full min-h-0 gap-4 overflow-y-auto pt-4 pr-2">
                <div v-if="!isJdbcConnection" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.connectionUrlOptional") }}</Label>
                  <div class="col-span-3 flex items-center gap-1">
                    <Input v-model="connectionUrlInput" class="flex-1" :placeholder="connectionUrlPlaceholder" @keydown.enter.prevent="applyConnectionUrl" />
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="!connectionUrlInput.trim()" :aria-label="t('connection.parseConnectionUrl')" @click="applyConnectionUrl">
                          <Link2 class="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{{ t("connection.parseConnectionUrl") }}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.name") }}</Label>
                  <Input v-model="form.name" class="col-span-3" :placeholder="t('connection.namePlaceholder')" />
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.type") }}</Label>
                  <button type="button" class="col-span-3 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 hover:bg-muted/40 cursor-pointer transition" @click="backToDatabasePicker()">
                    <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
                    <span class="min-w-0 flex-1 truncate text-sm text-left">{{ selectedProfile().label }}</span>
                    <Pencil class="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>

                <!-- OceanBase mode toggle -->
                <div v-if="selectedType === 'oceanbase'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button size="sm" :variant="oceanbaseSubMode === 'mysql' ? 'default' : 'outline'" @click="switchOceanbaseMode('mysql')">
                      {{ t("connection.oceanbaseMySQLMode") }}
                    </Button>
                    <Button size="sm" :variant="oceanbaseSubMode === 'oracle' ? 'default' : 'outline'" @click="switchOceanbaseMode('oracle')">
                      {{ t("connection.oceanbaseOracleMode") }}
                    </Button>
                  </div>
                </div>

                <div v-if="selectedType === 'gbase'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.version") }}</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button size="sm" :variant="form.driver_profile === 'gbase8s' ? 'outline' : 'default'" @click="switchGbaseProfile('gbase8a')"> GBase 8a </Button>
                    <Button size="sm" :variant="form.driver_profile === 'gbase8s' ? 'default' : 'outline'" @click="switchGbaseProfile('gbase8s')"> GBase 8s </Button>
                  </div>
                </div>

                <div v-if="isCustomCompatibleProfile()" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.driverName") }}</Label>
                  <Input v-model="customDriverName" class="col-span-3" :placeholder="t('connection.driverNamePlaceholder')" />
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.color") }}</Label>
                  <div class="col-span-3 flex items-center gap-1.5">
                    <button
                      v-for="color in colorOptions"
                      :key="color.value || 'none'"
                      type="button"
                      class="h-6 w-6 rounded-full border ring-offset-background transition hover:scale-105"
                      :class="[color.class, form.color === color.value ? 'ring-2 ring-ring ring-offset-2' : 'border-border']"
                      :title="t(color.labelKey)"
                      @click="handlePresetClick(color.value)"
                    />
                    <Popover v-model:open="customColorOpen">
                      <PopoverTrigger as-child>
                        <button
                          type="button"
                          class="h-6 w-6 rounded-full border flex items-center justify-center hover:scale-105 transition"
                          :class="[!isPresetColor(form.color) && form.color ? 'border-border ring-2 ring-ring ring-offset-2' : 'border-dashed border-border']"
                          :style="!isPresetColor(form.color) && form.color ? { backgroundColor: form.color } : {}"
                          :title="t('connection.colorCustom')"
                        >
                          <Pipette class="h-3.5 w-3.5" :class="!isPresetColor(form.color) && form.color ? 'text-white' : 'text-muted-foreground'" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent class="w-auto p-2">
                        <div class="flex items-center gap-2">
                          <input type="color" :value="form.color" @input="handleCustomColorPicked(($event.target as HTMLInputElement).value)" class="h-6 w-6 cursor-pointer rounded border-0 p-0" />
                          <Input type="text" :value="customColorInput || form.color" @input="handleCustomColorInput(($event.target as HTMLInputElement).value)" class="w-28 h-7 text-xs font-mono" :placeholder="'#ff0000 或 rgba(…)'" />
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                <div v-if="form.db_type === 'h2'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button size="sm" :variant="h2ConnectionMode === 'file' ? 'default' : 'outline'" @click="switchH2ConnectionMode('file')">
                      {{ t("connection.h2FileMode") }}
                    </Button>
                    <Button size="sm" :variant="h2ConnectionMode === 'tcp' ? 'default' : 'outline'" @click="switchH2ConnectionMode('tcp')">
                      {{ t("connection.h2TcpMode") }}
                    </Button>
                  </div>
                </div>

                <div v-if="form.db_type === 'h2'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">Driver</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button
                      size="sm"
                      :variant="form.driver_profile !== 'h2-legacy' ? 'default' : 'outline'"
                      @click="
                        form.driver_profile = 'h2';
                        resetTestState();
                      "
                      >H2 2.3</Button
                    >
                    <Button
                      size="sm"
                      :variant="form.driver_profile === 'h2-legacy' ? 'default' : 'outline'"
                      @click="
                        form.driver_profile = 'h2-legacy';
                        resetTestState();
                      "
                      >H2 2.1 Legacy</Button
                    >
                  </div>
                </div>

                <div v-if="h2DriverMissing" class="grid grid-cols-4 items-center gap-4">
                  <span />
                  <p class="col-span-3 text-xs text-muted-foreground">
                    {{ t("connection.driverInstallHintPrefix") }}<a class="underline cursor-pointer text-primary hover:text-primary/80" @click="emit('openDriverStore', agentDriverFocus)">{{ t("toolbar.driverManager") }}</a
                    >{{ t("connection.driverInstallHintSuffix") }}
                  </p>
                </div>

                <!-- JDBC: optional external plugin -->
                <template v-if="isJdbcConnection">
                  <div v-if="form.driver_profile === 'dremio'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 flex gap-2">
                      <Button size="sm" :variant="dremioConnectionMode === 'arrow-flight-sql' ? 'default' : 'outline'" @click="applyDremioConnectionMode('arrow-flight-sql')">
                        {{ t("connection.dremioArrowFlightSqlMode") }}
                      </Button>
                      <Button size="sm" :variant="dremioConnectionMode === 'legacy' ? 'default' : 'outline'" @click="applyDremioConnectionMode('legacy')">
                        {{ t("connection.dremioLegacyJdbcMode") }}
                      </Button>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.jdbcUrl") }}</Label>
                    <Input v-model="form.connection_string" class="col-span-3" :placeholder="t('connection.jdbcUrlPlaceholder')" @blur="syncDremioConnectionModeFromUrl" />
                  </div>
                  <div v-if="isJdbcxConnection" class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.jdbcxExtensions") }}</Label>
                    <div class="col-span-3 flex items-start justify-between gap-4 rounded-md border px-3 py-2" :class="jdbcxHighPrivilegeExtensionsAllowed ? 'border-amber-500/60 bg-amber-500/10' : 'bg-muted/20'">
                      <div class="space-y-1">
                        <div class="text-sm font-medium">{{ t("connection.jdbcxHighPrivilegeExtensions") }}</div>
                        <p class="text-xs text-muted-foreground">{{ t("connection.jdbcxHighPrivilegeExtensionsWarning") }}</p>
                      </div>
                      <Switch v-model="jdbcxHighPrivilegeExtensionsAllowed" class="mt-0.5 shrink-0" />
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" :placeholder="jdbcUsernamePlaceholder" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.jdbcDriverPaths") }}</Label>
                    <div class="col-span-3 space-y-2">
                      <Select v-if="jdbcDriverSelectItems.length > 0" :model-value="selectedJdbcDriverPath" @update:model-value="onJdbcDriverSelect">
                        <SelectTrigger>
                          <SelectValue :placeholder="t('connection.jdbcDriverSelectPlaceholder')" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="driver in jdbcDriverSelectItems" :key="driver.id" :value="driver.id">
                            {{ driver.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <div class="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
                        <div class="flex min-w-0 items-center gap-2">
                          <div class="truncate text-xs font-medium">{{ t("connection.jdbcManualClasspath") }}</div>
                          <Badge variant="outline" class="h-5 shrink-0 rounded-full px-2 text-[10px] font-medium">
                            {{ t("connection.jdbcManualClasspathCount", { count: jdbcManualClasspathCount }) }}
                          </Badge>
                        </div>
                        <Switch v-model="jdbcManualClasspathOpen" />
                      </div>
                      <div v-if="jdbcManualClasspathOpen" class="flex items-start gap-1">
                        <textarea
                          v-model="jdbcDriverPathsInput"
                          class="flex min-h-12 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          :placeholder="t('connection.jdbcDriverPathsPlaceholder')"
                        />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button type="button" variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseJdbcDriverPaths">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.jdbcDriverBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.jdbcDriverClass") }}</Label>
                    <Input v-model="form.jdbc_driver_class" class="col-span-3" :placeholder="t('connection.jdbcDriverClassPlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <div class="col-span-3 space-y-2">
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.jdbcPluginHint") }}
                      </p>
                      <div class="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" @click="emit('openDriverStore', { target: 'tab', tab: 'jdbc' })">
                          <FolderOpen class="h-3.5 w-3.5" />
                          {{ t("toolbar.driverManager") }}
                        </Button>
                        <Button type="button" variant="outline" size="sm" @click="openExternalUrl('https://dbxio.com')">
                          <ExternalLink class="h-3.5 w-3.5" />
                          {{ t("connection.jdbcDocs") }}
                        </Button>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- Local database files: file path only -->
                <template v-else-if="usesLocalFilePathInput">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.filePath") }}</Label>
                    <div class="col-span-3 space-y-1">
                      <div class="flex items-center gap-1">
                        <Input v-model="form.host" class="flex-1" :placeholder="filePathPlaceholder" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseDbFilePath">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.sshKeyPathBrowse") }}</TooltipContent>
                        </Tooltip>
                        <Tooltip v-if="isDesktop && form.db_type === 'duckdb'">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="createDuckDbFilePath">
                              <FilePlus2 class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.createDuckDbFile") }}</TooltipContent>
                        </Tooltip>
                        <Tooltip v-if="isDesktop && form.db_type === 'sqlite'">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="createSqliteFilePath">
                              <FilePlus2 class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.createSqliteFile") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p v-if="supportsMemoryDatabasePath" class="text-xs text-muted-foreground">
                        {{ t("connection.memoryDatabasePathHint") }}
                      </p>
                    </div>
                  </div>
                  <div v-if="form.db_type === 'sqlite'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.sqliteCipherKey") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" :placeholder="t('connection.sqliteCipherKeyPlaceholder')" />
                  </div>
                  <div v-if="form.db_type === 'sqlite'" class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.sqliteExtensions") }}</Label>
                    <div class="col-span-3 space-y-1">
                      <div class="flex items-start gap-1">
                        <textarea
                          v-model="sqliteExtensionPaths"
                          class="flex min-h-[76px] flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          :placeholder="t('connection.sqliteExtensionsPlaceholder')"
                          spellcheck="false"
                        />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseSqliteExtensionPath">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.sqliteExtensionBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.sqliteExtensionsHint") }}
                      </p>
                    </div>
                  </div>
                  <div v-if="form.db_type === 'duckdb'" class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.initScript") }}</Label>
                    <div class="col-span-3 space-y-1">
                      <textarea
                        v-model="form.init_script"
                        class="flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        :placeholder="t('connection.initScriptPlaceholder')"
                        spellcheck="false"
                      />
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.initScriptHint") }}
                      </p>
                    </div>
                  </div>
                  <template v-if="form.db_type === 'h2' || form.db_type === 'access'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.user") }}{{ form.db_type === "access" ? "（可选）" : "" }}</Label>
                      <Input v-model="form.username" class="col-span-3" :placeholder="form.db_type === 'access' ? '' : 'sa'" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.password") }}{{ form.db_type === "access" ? "（可选）" : "" }}</Label>
                      <PasswordInput v-model="form.password" class="col-span-3" />
                    </div>
                  </template>
                </template>

                <!-- Message Queue: admin URL and auth -->
                <template v-else-if="form.db_type === 'mq'">
                  <template v-if="mqSystemKind === 'kafka'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqBootstrapServers") }}</Label>
                      <Input v-model="mqKafkaBootstrapServers" class="col-span-3" :placeholder="t('connection.mqBootstrapServersPlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqSecurity") }}</Label>
                      <Select v-model="mqKafkaSecurityProtocol">
                        <SelectTrigger class="col-span-3 h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="option in mqKafkaSecurityProtocolOptions" :key="option.value" :value="option.value">
                            {{ option.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </template>
                  <template v-else-if="mqSystemKind === 'rocketmq'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.rocketmqNamesrvAddr") }}</Label>
                      <Input v-model="mqRocketmqNamesrvAddr" class="col-span-3" :placeholder="t('connection.rocketmqNamesrvAddrPlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.rocketmqClusterName") }}</Label>
                      <Input v-model="mqRocketmqClusterName" class="col-span-3" :placeholder="t('connection.rocketmqClusterNamePlaceholder')" />
                    </div>
                  </template>
                  <template v-else>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqAdminUrl") }}</Label>
                      <Input v-model="mqAdminUrl" class="col-span-3" placeholder="http://127.0.0.1:8080" />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.mqAuth") }}</Label>
                    <div class="col-span-3 flex flex-wrap gap-2">
                      <Button size="sm" :variant="mqAuthKind === 'none' ? 'default' : 'outline'" @click="mqAuthKind = 'none'">{{ t("connection.mqAuthNone") }}</Button>
                      <Button v-if="mqSystemKind === 'pulsar'" size="sm" :variant="mqAuthKind === 'token' ? 'default' : 'outline'" @click="mqAuthKind = 'token'">{{ t("connection.mqAuthToken") }}</Button>
                      <Button size="sm" :variant="mqAuthKind === 'basic' ? 'default' : 'outline'" @click="mqAuthKind = 'basic'">{{ mqSystemKind === "rocketmq" ? t("connection.rocketmqAclAuth") : t("connection.mqAuthBasic") }}</Button>
                      <Button v-if="mqSystemKind === 'kafka'" size="sm" :variant="mqAuthKind === 'kerberos' ? 'default' : 'outline'" @click="mqAuthKind = 'kerberos'">{{ t("connection.mqAuthKerberos") }}</Button>
                      <Button v-if="mqSystemKind === 'pulsar'" size="sm" :variant="mqAuthKind === 'apiKey' ? 'default' : 'outline'" @click="mqAuthKind = 'apiKey'">{{ t("connection.mqAuthApiKey") }}</Button>
                      <Button v-if="mqSystemKind === 'pulsar'" size="sm" :variant="mqAuthKind === 'oauth2' ? 'default' : 'outline'" @click="mqAuthKind = 'oauth2'">{{ t("connection.mqAuthOauth2") }}</Button>
                    </div>
                  </div>
                  <template v-if="mqAuthKind === 'token'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqToken") }}</Label>
                      <PasswordInput v-model="mqToken" class="col-span-3" />
                    </div>
                  </template>
                  <template v-else-if="mqAuthKind === 'basic'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ mqSystemKind === "rocketmq" ? t("connection.rocketmqAccessKey") : t("connection.user") }}</Label>
                      <Input v-model="mqBasicUsername" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ mqSystemKind === "rocketmq" ? t("connection.rocketmqSecretKey") : t("connection.password") }}</Label>
                      <PasswordInput v-model="mqBasicPassword" class="col-span-3" />
                    </div>
                    <div v-if="mqSystemKind === 'kafka'" class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqSaslMechanism") }}</Label>
                      <Select v-model="mqKafkaSaslMechanism">
                        <SelectTrigger class="col-span-3 h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="option in mqKafkaSaslMechanismOptions" :key="option.value" :value="option.value">
                            {{ option.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </template>
                  <template v-else-if="mqSystemKind === 'kafka' && mqAuthKind === 'kerberos'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.kafkaKerberosPrincipal") }}</Label>
                      <Input v-model="mqKafkaKerberosPrincipal" class="col-span-3" placeholder="user@EXAMPLE.COM" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.kafkaKerberosKeytab") }}</Label>
                      <div class="col-span-3 flex items-center gap-1">
                        <Input v-model="mqKafkaKerberosKeytabPath" class="flex-1" :placeholder="t('connection.kafkaKerberosKeytabPlaceholder')" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseKafkaKerberosFile('keytab')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.kafkaKerberosKeytabBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.kafkaKerberosServiceName") }}</Label>
                      <Input v-model="mqKafkaKerberosServiceName" class="col-span-3" placeholder="kafka" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.kafkaKerberosKrb5Conf") }}</Label>
                      <div class="col-span-3 flex items-center gap-1">
                        <Input v-model="mqKafkaKrb5ConfPath" class="flex-1" :placeholder="t('connection.kafkaKerberosKrb5ConfPlaceholder')" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseKafkaKerberosFile('krb5')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.kafkaKerberosKrb5ConfBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div class="grid grid-cols-4 items-start gap-4">
                      <div></div>
                      <div class="col-span-3 space-y-1 text-xs leading-5 text-muted-foreground">
                        <p>{{ t("connection.kafkaKerberosPathHint") }}</p>
                        <p>{{ t("connection.kafkaKerberosAuthHint") }}</p>
                      </div>
                    </div>
                  </template>
                  <template v-else-if="mqAuthKind === 'apiKey'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqApiKeyHeader") }}</Label>
                      <Input v-model="mqApiKeyHeader" class="col-span-3" placeholder="Authorization" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqApiKeyValue") }}</Label>
                      <PasswordInput v-model="mqApiKeyValue" class="col-span-3" />
                    </div>
                  </template>
                  <template v-else-if="mqAuthKind === 'oauth2'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqOauthIssuerUrl") }}</Label>
                      <Input v-model="mqOauthIssuerUrl" class="col-span-3" placeholder="https://issuer.example.com/oauth/token" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqOauthClientId") }}</Label>
                      <Input v-model="mqOauthClientId" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqOauthClientSecret") }}</Label>
                      <PasswordInput v-model="mqOauthClientSecret" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqOauthAudience") }}</Label>
                      <Input v-model="mqOauthAudience" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.mqOauthScope") }}</Label>
                      <Input v-model="mqOauthScope" class="col-span-3" />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mqTls") }}</Label>
                    <label class="col-span-3 inline-flex items-center gap-2">
                      <input type="checkbox" v-model="mqTlsSkipVerify" class="mr-0" />
                      <span class="text-xs text-muted-foreground">{{ t("connection.mqTlsSkipVerify") }}</span>
                    </label>
                  </div>
                  <div v-if="mqSystemKind === 'pulsar'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.mqPinnedVersion") }}</Label>
                    <Select v-model="mqPinnedVersion">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in MQ_PINNED_VERSION_OPTIONS" :key="option.value" :value="option.value">
                          <div class="grid gap-0.5 text-left">
                            <span>{{ option.label }}</span>
                            <span class="text-xs text-muted-foreground">{{ option.description }}</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div v-if="mqSystemKind === 'pulsar'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.mqTokenSigning") }}</Label>
                    <Select v-model="mqTokenSigningMode">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{{ t("connection.mqTokenSigningNone") }}</SelectItem>
                        <SelectItem value="hs256">HS256 SECRET</SelectItem>
                        <SelectItem value="rs256">RS256 PRIVATE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div v-if="mqSystemKind !== 'kafka' && mqTokenSigningMode !== 'none'" class="grid grid-cols-4 items-start gap-4">
                    <Label class="pt-2 text-right">{{ t("connection.mqTokenSigningKey") }}</Label>
                    <textarea
                      v-model="mqTokenSigningKey"
                      class="col-span-3 min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      :placeholder="mqTokenSigningMode === 'hs256' ? t('connection.mqTokenSigningKeyPlaceholderHs256') : t('connection.mqTokenSigningKeyPlaceholderRs256')"
                    />
                  </div>
                  <div v-if="mqSystemKind !== 'kafka' && mqTokenSigningMode !== 'none'" class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 m-0 text-xs leading-5 text-muted-foreground">{{ t("connection.mqTokenSigningHint") }}</p>
                  </div>
                </template>

                <!-- Nacos: server address, namespace and auth -->
                <template v-else-if="form.db_type === 'nacos'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.nacosConsoleUrl") }}</Label>
                    <Input v-model="nacosServerAddr" class="col-span-3" placeholder="http://127.0.0.1:8085" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 m-0 text-xs leading-5 text-muted-foreground">{{ t("connection.nacosConsoleUrlHint") }}</p>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.nacosNamespace") }}</Label>
                    <Input v-model="nacosNamespace" class="col-span-3" placeholder="public" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.nacosContextPath") }}</Label>
                    <Input v-model="nacosContextPath" class="col-span-3" :placeholder="t('connection.nacosContextPathPlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.nacosAuth") }}</Label>
                    <div class="col-span-3 flex flex-wrap gap-2">
                      <Button size="sm" :variant="nacosAuthKind === 'none' ? 'default' : 'outline'" @click="nacosAuthKind = 'none'">{{ t("connection.nacosAuthNone") }}</Button>
                      <Button size="sm" :variant="nacosAuthKind === 'usernamePassword' ? 'default' : 'outline'" @click="nacosAuthKind = 'usernamePassword'">{{ t("connection.nacosAuthUserPassword") }}</Button>
                    </div>
                  </div>
                  <template v-if="nacosAuthKind === 'usernamePassword'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                      <Input v-model="nacosUsername" class="col-span-3" placeholder="nacos" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                      <PasswordInput v-model="nacosPassword" class="col-span-3" />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.nacosTls") }}</Label>
                    <label class="col-span-3 inline-flex items-center gap-2">
                      <input type="checkbox" v-model="nacosTlsSkipVerify" class="mr-0" />
                      <span class="text-xs text-muted-foreground">{{ t("connection.nacosTlsSkipVerify") }}</span>
                    </label>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.nacosPageSize") }}</Label>
                    <Input v-model.number="nacosPageSize" type="number" min="1" max="500" class="col-span-3" />
                  </div>
                </template>

                <!-- Redis: host, port, user, password, ssl -->
                <template v-else-if="form.db_type === 'redis'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 flex gap-2">
                      <Button size="sm" :variant="form.redis_connection_mode === 'standalone' ? 'default' : 'outline'" @click="form.redis_connection_mode = 'standalone'">
                        {{ t("connection.redisStandaloneMode") }}
                      </Button>
                      <Button size="sm" :variant="form.redis_connection_mode === 'sentinel' ? 'default' : 'outline'" @click="form.redis_connection_mode = 'sentinel'">
                        {{ t("connection.redisSentinelMode") }}
                      </Button>
                      <Button size="sm" :variant="form.redis_connection_mode === 'cluster' ? 'default' : 'outline'" @click="form.redis_connection_mode = 'cluster'">
                        {{ t("connection.redisClusterMode") }}
                      </Button>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ form.redis_connection_mode === "sentinel" ? t("connection.redisFirstSentinel") : form.redis_connection_mode === "cluster" ? t("connection.redisFirstClusterNode") : t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <template v-if="form.redis_connection_mode === 'sentinel'">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label :class="connectionLabelTopClass">{{ t("connection.redisSentinelNodes") }}</Label>
                      <textarea
                        v-model="form.redis_sentinel_nodes"
                        class="col-span-3 flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="sentinel-1:26379&#10;sentinel-2:26379"
                        spellcheck="false"
                      />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.redisSentinelMaster") }}</Label>
                      <Input v-model="form.redis_sentinel_master" class="col-span-3" placeholder="mymaster" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.redisSentinelUser") }}</Label>
                      <Input v-model="form.redis_sentinel_username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.redisSentinelPassword") }}</Label>
                      <PasswordInput v-model="form.redis_sentinel_password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.redisSentinelTls") }}</Label>
                      <label class="col-span-3 inline-flex items-center gap-2">
                        <input type="checkbox" v-model="form.redis_sentinel_tls" class="mr-0" />
                        <span class="text-xs text-muted-foreground">{{ t("connection.redisSentinelTlsHint") }}</span>
                      </label>
                    </div>
                  </template>
                  <template v-else-if="form.redis_connection_mode === 'cluster'">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label :class="connectionLabelTopClass">{{ t("connection.redisClusterNodes") }}</Label>
                      <textarea
                        v-model="form.redis_cluster_nodes"
                        class="col-span-3 flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="redis-1:6379&#10;redis-2:6379"
                        spellcheck="false"
                      />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" placeholder="default" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.redisKeySeparator") }}</Label>
                    <Input v-model="form.redis_key_separator" class="col-span-3 h-8 text-xs" placeholder=":" />
                  </div>
                </template>

                <!-- etcd: endpoints, user, password, TLS -->
                <template v-else-if="form.db_type === 'etcd'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.etcdEndpoints") }}</Label>
                    <div class="col-span-3 space-y-1">
                      <textarea
                        v-model="etcdEndpointsLines"
                        class="flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="http://127.0.0.1:2379&#10;https://etcd-2:2379"
                        spellcheck="false"
                      />
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.etcdEndpointsHint") }}
                      </p>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" />
                  </div>
                </template>

                <!-- ZooKeeper: host, connect string, user, password -->
                <template v-else-if="form.db_type === 'zookeeper'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" placeholder="127.0.0.1" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelTopClass">{{ t("connection.zookeeperConnectString") }}</Label>
                    <div class="col-span-3 space-y-1">
                      <textarea
                        v-model="zookeeperConnectString"
                        class="flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="127.0.0.1:2181&#10;zk-2:2181"
                        spellcheck="false"
                      />
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.zookeeperConnectStringHint") }}
                      </p>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" />
                  </div>
                </template>

                <!-- MongoDB: URL or form -->
                <template v-else-if="form.db_type === 'mongodb'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.driverMode") }}</Label>
                    <div class="col-span-3 flex items-center gap-2">
                      <Button size="sm" :variant="mongoDriverMode === 'legacy' ? 'outline' : 'default'" @click="mongoDriverMode = 'auto'">{{ t("connection.mongoDriverAuto") }}</Button>
                      <Button size="sm" :variant="mongoDriverMode === 'legacy' ? 'default' : 'outline'" @click="mongoDriverMode = 'legacy'">{{ t("connection.mongoDriverLegacy") }}</Button>
                      <Tooltip>
                        <TooltipTrigger as-child>
                          <CircleHelp class="h-3.5 w-3.5 cursor-help text-muted-foreground hover:text-foreground" />
                        </TooltipTrigger>
                        <TooltipContent side="top" align="center" class="max-w-[320px] text-xs leading-relaxed">
                          {{ t("connection.mongoLegacyHint") }}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 flex gap-2">
                      <Button size="sm" :variant="mongoUseUrl ? 'outline' : 'default'" @click="mongoUseUrl = false">{{ t("connection.modeForm") }}</Button>
                      <Button size="sm" :variant="mongoUseUrl ? 'default' : 'outline'" @click="mongoUseUrl = true">URL</Button>
                    </div>
                  </div>
                  <template v-if="mongoUseUrl">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label :class="connectionLabelTopClass">URL</Label>
                      <textarea
                        v-model="form.connection_string"
                        class="col-span-3 flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="mongodb+srv://user:pass@cluster.mongodb.net/mydb"
                      />
                    </div>
                  </template>
                  <template v-else>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.host") }}</Label>
                      <Input v-model="form.host" class="col-span-2" />
                      <Input v-model.number="form.port" type="number" class="col-span-1" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <span />
                      <label class="col-span-3 flex items-center gap-2 text-sm">
                        <input type="checkbox" v-model="form.ssl" class="mr-0" />
                        <span>{{ t("connection.sslEnable") }}</span>
                      </label>
                    </div>
                    <template v-if="form.ssl">
                      <div class="grid grid-cols-4 items-start gap-4">
                        <Label :class="connectionLabelClass">{{ t("connection.mongoTlsAllowInvalidCertificates") }}</Label>
                        <label class="col-span-3 flex items-start gap-2 cursor-pointer">
                          <input v-model="mongoTlsAllowInvalidCertificates" type="checkbox" class="mr-0 mt-0.5" />
                          <span class="text-xs leading-5 text-muted-foreground">
                            {{ t("connection.mongoTlsAllowInvalidCertificatesHint") }}
                          </span>
                        </label>
                      </div>
                      <div class="grid grid-cols-4 items-start gap-4">
                        <Label :class="connectionLabelClass">{{ t("connection.mongoRetryWrites") }}</Label>
                        <label class="col-span-3 flex items-start gap-2 cursor-pointer">
                          <input v-model="mongoRetryWrites" type="checkbox" class="mr-0 mt-0.5" />
                          <span class="text-xs leading-5 text-muted-foreground">
                            {{ t("connection.mongoRetryWritesHint") }}
                          </span>
                        </label>
                      </div>
                      <div class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelClass">{{ t("connection.caCertPath") }}</Label>
                        <div class="col-span-3 flex items-center gap-1">
                          <Input v-model="form.ca_cert_path" class="flex-1" :placeholder="t('connection.caCertPathPlaceholder')" />
                          <Tooltip v-if="isDesktop">
                            <TooltipTrigger as-child>
                              <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseCaCertPath">
                                <FolderOpen class="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{{ t("connection.caCertPathBrowse") }}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </template>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                      <Input v-model="form.username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                      <PasswordInput v-model="form.password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.defaultDatabase") }}</Label>
                      <Input v-model="form.database" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.authDatabase") }}</Label>
                      <Input v-model="mongoAuthDatabase" class="col-span-3" :placeholder="t('connection.authDatabasePlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.authMechanism") }}</Label>
                      <Select v-model="mongoAuthMechanism">
                        <SelectTrigger class="col-span-3">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">{{ t("connection.authMechanismDefault") }}</SelectItem>
                          <SelectItem value="SCRAM-SHA-1">SCRAM-SHA-1</SelectItem>
                          <SelectItem value="SCRAM-SHA-256">SCRAM-SHA-256</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.urlParams") }}</Label>
                      <Input v-model="form.url_params" class="col-span-3" placeholder="replicaSet=rs0&authSource=admin" />
                    </div>
                  </template>
                </template>

                <!-- InfluxDB: v1 username/password or v2 token/org/bucket -->
                <template v-else-if="form.db_type === 'influxdb'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.version") }}</Label>
                    <Select v-model="influxDbVersion">
                      <SelectTrigger class="col-span-3">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">InfluxDB 1.x</SelectItem>
                        <SelectItem value="2">InfluxDB 2.x</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <span />
                    <label class="col-span-3 flex items-center gap-2 text-sm">
                      <input type="checkbox" v-model="form.ssl" class="mr-0" />
                      <span>{{ t("connection.sslEnable") }}</span>
                    </label>
                  </div>
                  <template v-if="influxDbVersion === '2'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">Organization</Label>
                      <Input v-model="influxDbOrg" class="col-span-3" placeholder="my-org" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">Bucket</Label>
                      <Input v-model="form.database" class="col-span-3" placeholder="my-bucket" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">Token</Label>
                      <PasswordInput v-model="form.password" class="col-span-3" />
                    </div>
                  </template>
                  <template v-else>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                      <Input v-model="form.username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                      <PasswordInput v-model="form.password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.database") }}</Label>
                      <Input v-model="form.database" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.urlParams") }}</Label>
                    <Input v-model="form.url_params" class="col-span-3" :placeholder="influxDbVersion === '2' ? 'precision=ns' : 'epoch=ms'" />
                  </div>
                </template>

                <!-- Turso: simplified form (URL + Token) -->
                <template v-else-if="form.db_type === 'turso'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-3" placeholder="your-database.turso.io 或 libsql://your-database.turso.io" />
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 text-xs text-muted-foreground">支持 libsql:// 或 https:// 协议，也可以只填主机名（自动使用 HTTPS）</p>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">Auth Token</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..." />
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 text-xs text-muted-foreground">使用 <code class="px-1 py-0.5 rounded bg-muted text-xs">turso db tokens create &lt;database-name&gt;</code> 创建 token</p>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.urlParams") }}</Label>
                    <Input v-model="form.url_params" class="col-span-3" placeholder="authToken=xxx（可选，优先使用上面的 Token 字段）" />
                  </div>
                </template>

                <template v-else-if="form.db_type === 'cloudflare-d1'">
                  <CloudflareD1ConnectionFields v-model:account-id="form.host" v-model:database-id="form.database" v-model:api-token="form.password" />
                </template>

                <!-- MySQL / PostgreSQL: host, port, user, password, database -->
                <template v-else>
                  <div v-if="form.db_type === 'elasticsearch'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 grid h-8 grid-cols-2 overflow-hidden rounded-md border border-input bg-muted/30 p-0.5">
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="elasticsearchConnectionMode === 'direct' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                        :aria-pressed="elasticsearchConnectionMode === 'direct'"
                        @click="switchElasticsearchConnectionMode('direct')"
                      >
                        {{ t("connection.elasticsearchDirectMode") }}
                      </button>
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="elasticsearchConnectionMode === 'kibana' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                        :aria-pressed="elasticsearchConnectionMode === 'kibana'"
                        @click="switchElasticsearchConnectionMode('kibana')"
                      >
                        {{ t("connection.elasticsearchKibanaProxyMode") }}
                      </button>
                    </div>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ form.db_type === "elasticsearch" && elasticsearchConnectionMode === "kibana" ? t("connection.elasticsearchKibanaHost") : t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" @input="markSqlServerPortExplicit" />
                  </div>

                  <div v-if="form.db_type === 'elasticsearch' && elasticsearchConnectionMode === 'kibana'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.elasticsearchKibanaBasePath") }}</Label>
                    <Input v-model="elasticsearchKibanaBasePath" class="col-span-3" placeholder="/kibana/s/default" @input="resetTestState" />
                  </div>

                  <div v-if="form.driver_profile === 'gbase8s'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.gbaseServer") }}</Label>
                    <Input v-model="form.gbase_server" class="col-span-3" placeholder="gbase01" />
                  </div>

                  <div v-if="form.db_type === 'informix'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.informixServer") }}</Label>
                    <Input v-model="form.informix_server" class="col-span-3" placeholder="ol_informix1170" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.password") }}</Label>
                    <PasswordInput v-model="form.password" class="col-span-3" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ databaseLabel }}</Label>
                    <Input v-model="form.database" class="col-span-3" :placeholder="databasePlaceholder" />
                  </div>

                  <template v-if="form.db_type === 'hive'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.hiveAuthMode") }}</Label>
                      <div class="col-span-3 grid h-8 grid-cols-2 overflow-hidden rounded-md border border-input bg-muted/30 p-0.5">
                        <button type="button" class="h-7 rounded-sm px-3 text-sm transition-colors" :class="hiveAuthMode === 'none' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" :aria-pressed="hiveAuthMode === 'none'" @click="hiveAuthMode = 'none'">
                          {{ t("connection.hiveAuthNone") }}
                        </button>
                        <button
                          type="button"
                          class="h-7 rounded-sm px-3 text-sm transition-colors"
                          :class="hiveAuthMode === 'kerberos' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                          :aria-pressed="hiveAuthMode === 'kerberos'"
                          @click="hiveAuthMode = 'kerberos'"
                        >
                          Kerberos
                        </button>
                      </div>
                    </div>

                    <template v-if="hiveAuthMode === 'kerberos'">
                      <div class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelSmallClass">{{ t("connection.hivePrincipal") }}</Label>
                        <Input v-model="hivePrincipal" class="col-span-3" placeholder="hive/_HOST@EXAMPLE.COM" />
                      </div>
                      <div class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelSmallClass">krb5.conf</Label>
                        <div class="col-span-3 flex items-center gap-1">
                          <Input v-model="hiveKrb5ConfPath" class="flex-1" placeholder="/etc/krb5.conf" />
                          <Tooltip v-if="isDesktop">
                            <TooltipTrigger as-child>
                              <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseHiveKerberosFile('krb5')">
                                <FolderOpen class="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{{ t("connection.hiveKrb5ConfBrowse") }}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      <div class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelSmallClass">JAAS</Label>
                        <div class="col-span-3 flex items-center gap-1">
                          <Input v-model="hiveJaasConfigPath" class="flex-1" placeholder="/etc/hive-jaas.conf" />
                          <Tooltip v-if="isDesktop">
                            <TooltipTrigger as-child>
                              <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseHiveKerberosFile('jaas')">
                                <FolderOpen class="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{{ t("connection.hiveJaasConfigBrowse") }}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      <div class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelSmallClass">{{ t("connection.hiveTicketCache") }}</Label>
                        <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" v-model="hiveUseSubjectCredsOnlyFalse" class="mr-0" />
                          <span class="text-xs text-muted-foreground">{{ t("connection.hiveTicketCacheFallback") }}</span>
                        </label>
                      </div>
                      <div class="grid grid-cols-4 items-start gap-4">
                        <Label :class="connectionLabelTopClass">{{ t("connection.hiveJvmOptions") }}</Label>
                        <textarea
                          v-model="hiveExtraJavaOptions"
                          class="col-span-3 min-h-16 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          :placeholder="t('connection.hiveJvmOptionsPlaceholder')"
                        />
                      </div>
                    </template>
                  </template>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 grid h-8 grid-cols-2 overflow-hidden rounded-md border border-input bg-muted/30 p-0.5">
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="form.oracle_connection_type !== 'sid' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                        :aria-pressed="form.oracle_connection_type !== 'sid'"
                        @click="form.oracle_connection_type = 'service_name'"
                      >
                        {{ t("connection.serviceNameOnly") }}
                      </button>
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="form.oracle_connection_type === 'sid' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                        :aria-pressed="form.oracle_connection_type === 'sid'"
                        @click="form.oracle_connection_type = 'sid'"
                      >
                        SID
                      </button>
                    </div>
                  </div>

                  <div v-if="shouldShowAgentDriverInstallHint" class="grid grid-cols-4 items-center gap-4">
                    <span />
                    <p class="col-span-3 text-xs text-muted-foreground">
                      {{ t("connection.driverInstallHintPrefix") }}<a class="underline cursor-pointer text-primary hover:text-primary/80" @click="emit('openDriverStore', agentDriverFocus)">{{ t("toolbar.driverManager") }}</a
                      >{{ t("connection.driverInstallHintSuffix") }}
                    </p>
                  </div>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">SYSDBA</Label>
                    <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" v-model="form.sysdba" class="mr-0" :disabled="isOracleSysUser(form)" />
                      <span class="text-xs text-muted-foreground">as SYSDBA</span>
                    </label>
                  </div>

                  <div v-if="supportsGenericUrlParams" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelClass">{{ t("connection.urlParams") }}</Label>
                    <Input
                      v-model="form.url_params"
                      class="col-span-3"
                      :placeholder="
                        form.db_type === 'mysql'
                          ? 'charset=utf8mb4'
                          : form.db_type === 'saphana'
                            ? 'databaseName=TENANT_DB'
                            : form.db_type === 'clickhouse'
                              ? 'secure=true'
                              : form.db_type === 'bigquery'
                                ? 'OAuthType=0;OAuthServiceAcctEmail=svc@project.iam.gserviceaccount.com;OAuthPvtKeyPath=/path/key.json'
                                : form.db_type === 'informix'
                                  ? 'CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8'
                                  : form.db_type === 'spark'
                                    ? 'catalog=paimon_catalog'
                                    : form.db_type === 'cassandra'
                                      ? 'localdatacenter=dc1'
                                      : 'sslmode=disable'
                      "
                    />
                  </div>

                  <template v-if="isPrestoSqlConnection">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label :class="connectionLabelTopClass">{{ t("connection.jdbcDriverPaths") }}</Label>
                      <div class="col-span-3 space-y-2">
                        <Select v-if="jdbcDriverSelectItems.length > 0" :model-value="selectedJdbcDriverPath" @update:model-value="onJdbcDriverSelect">
                          <SelectTrigger>
                            <SelectValue :placeholder="t('connection.jdbcDriverSelectPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="driver in jdbcDriverSelectItems" :key="driver.id" :value="driver.id">
                              {{ driver.label }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <div class="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
                          <div class="flex min-w-0 items-center gap-2">
                            <div class="truncate text-xs font-medium">{{ t("connection.jdbcManualClasspath") }}</div>
                            <Badge variant="outline" class="h-5 shrink-0 rounded-full px-2 text-[10px] font-medium">
                              {{ t("connection.jdbcManualClasspathCount", { count: jdbcManualClasspathCount }) }}
                            </Badge>
                          </div>
                          <Switch v-model="jdbcManualClasspathOpen" />
                        </div>
                        <div v-if="jdbcManualClasspathOpen" class="flex items-start gap-1">
                          <textarea
                            v-model="jdbcDriverPathsInput"
                            class="flex min-h-12 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            :placeholder="t('connection.jdbcDriverPathsPlaceholder')"
                          />
                          <Tooltip v-if="isDesktop">
                            <TooltipTrigger as-child>
                              <Button type="button" variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseJdbcDriverPaths">
                                <FolderOpen class="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{{ t("connection.jdbcDriverBrowse") }}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelClass">{{ t("connection.jdbcDriverClass") }}</Label>
                      <Input v-model="form.jdbc_driver_class" class="col-span-3" :placeholder="t('connection.jdbcDriverClassPlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-start gap-4">
                      <span />
                      <div class="col-span-3 space-y-2">
                        <p class="text-xs text-muted-foreground">
                          {{ t("connection.jdbcPluginHint") }}
                        </p>
                        <div class="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" size="sm" @click="emit('openDriverStore', { target: 'tab', tab: 'jdbc' })">
                            <FolderOpen class="h-3.5 w-3.5" />
                            {{ t("toolbar.driverManager") }}
                          </Button>
                          <Button type="button" variant="outline" size="sm" @click="openExternalUrl('https://dbxio.com')">
                            <ExternalLink class="h-3.5 w-3.5" />
                            {{ t("connection.jdbcDocs") }}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </template>
                </template>

                <div v-if="visibleDatabaseInfo" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelClass">{{ t("connection.databaseInfo.title") }}</Label>
                  <Popover>
                    <PopoverTrigger as-child>
                      <button
                        type="button"
                        class="col-span-3 flex h-9 min-w-0 items-center gap-2 rounded-md border bg-muted/20 px-2.5 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :title="databaseInfoCompactLabel"
                        :aria-label="t('connection.databaseInfo.open', { database: databaseInfoCompactLabel })"
                      >
                        <DatabaseLucide class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span class="rounded-full bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">{{ databaseInfoStatusLabel }}</span>
                        <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ databaseInfoCompactLabel }}</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" class="w-[360px] max-w-[calc(100vw-24px)] gap-3 p-3" @click.stop @keydown.stop>
                      <div class="flex min-w-0 items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex min-w-0 items-center gap-2">
                            <DatabaseLucide class="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div class="min-w-0 text-sm font-medium">{{ t("connection.databaseInfo.title") }}</div>
                          </div>
                          <p class="mt-1 text-xs text-muted-foreground">{{ databaseInfoDescription }}</p>
                        </div>
                        <Button variant="ghost" size="icon-xs" class="h-7 w-7 shrink-0" :title="t('connection.databaseInfo.copy')" :aria-label="t('connection.databaseInfo.copy')" @click="copyDatabaseInfo">
                          <Copy class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <dl class="mt-3 grid min-w-0 grid-cols-[minmax(7.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                        <template v-for="row in databaseInfoDisplayRows" :key="row.key">
                          <dt class="text-muted-foreground">{{ row.label }}</dt>
                          <dd class="min-w-0 break-words text-right font-medium">{{ row.displayValue }}</dd>
                        </template>
                      </dl>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </TabsContent>

            <TabsContent v-if="supportsTlsToggle" value="tls" class="m-0 min-h-0 flex-1 overflow-hidden">
              <div class="connection-form-body grid h-full min-h-0 gap-4 overflow-y-auto overflow-x-hidden pt-4 pr-2">
                <div v-if="!supportsPostgresTlsOptions && !supportsMysqlTlsOptions" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">SSL/TLS</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.ssl" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.sslEnable") }}</span>
                  </label>
                </div>

                <div v-if="form.db_type === 'redis'" class="grid grid-cols-4 items-start gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.redisTlsInsecure") }}</Label>
                  <label class="col-span-3 flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" v-model="redisTlsInsecure" class="mr-0 mt-0.5" :disabled="!form.ssl" />
                    <span class="text-xs leading-5 text-muted-foreground">
                      {{ t("connection.redisTlsInsecureHint") }}
                    </span>
                  </label>
                </div>

                <template v-if="form.db_type === 'etcd'">
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <ShieldCheck class="h-3.5 w-3.5" />
                        {{ t("connection.caCertPath") }}
                      </span>
                    </Label>
                    <div class="col-span-3 space-y-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="form.ca_cert_path" class="flex-1" :placeholder="t('connection.etcdCaCertPlaceholder')" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseEtcdTlsFile('ca')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.etcdCaCertBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <KeyRound class="h-3.5 w-3.5" />
                        {{ t("connection.etcdClientAuth") }}
                      </span>
                    </Label>
                    <div class="col-span-3 grid gap-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="form.client_cert_path" class="flex-1" :placeholder="t('connection.etcdClientCertPlaceholder')" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseEtcdTlsFile('cert')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.etcdClientCertBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <div class="flex items-center gap-1">
                        <Input v-model="form.client_key_path" class="flex-1" :placeholder="t('connection.etcdClientKeyPlaceholder')" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" @click="browseEtcdTlsFile('key')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.etcdClientKeyBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ t("connection.etcdClientCertHint") }}
                      </p>
                    </div>
                  </div>
                </template>

                <template v-if="supportsMysqlTlsOptions">
                  <div v-if="supportsMysqlCleartextPasswordAuth" class="grid grid-cols-4 items-start gap-4">
                    <Label :class="[connectionLabelSmallPaddedClass, 'min-w-0 break-words']">{{ t("connection.mysqlCleartextPasswordAuth") }}</Label>
                    <div class="col-span-3 flex min-w-0 items-start justify-between gap-4">
                      <p class="min-w-0 text-[11px] leading-4 text-muted-foreground break-words">
                        {{ t("connection.mysqlCleartextPasswordAuthHint") }}
                      </p>
                      <Switch v-model="mysqlCleartextPasswordAuth" class="mt-0.5 shrink-0" />
                    </div>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.mysqlTlsMode") }}</Label>
                    <Select v-model="mysqlTlsMode">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="disabled">{{ t("connection.mysqlTlsModeDisabled") }}</SelectItem>
                        <SelectItem value="preferred">{{ t("connection.mysqlTlsModePreferred") }}</SelectItem>
                        <SelectItem value="required">{{ t("connection.mysqlTlsModeRequired") }}</SelectItem>
                        <SelectItem value="verify_ca">{{ t("connection.mysqlTlsModeVerifyCa") }}</SelectItem>
                        <SelectItem value="verify_identity">{{ t("connection.mysqlTlsModeVerifyIdentity") }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <ShieldCheck class="h-3.5 w-3.5" />
                        {{ t("connection.caCertPath") }}
                      </span>
                    </Label>
                    <div class="col-span-3 space-y-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="form.ca_cert_path" class="flex-1" :placeholder="t('connection.caCertPathPlaceholder')" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" @click="browseCaCertPath">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.caCertPathBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ t("connection.mysqlCaCertHint") }}
                      </p>
                    </div>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <KeyRound class="h-3.5 w-3.5" />
                        {{ t("connection.mysqlClientCert") }}
                      </span>
                    </Label>
                    <div class="col-span-3 grid gap-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="mysqlClientCertPath" class="flex-1" :placeholder="t('connection.mysqlClientCertPlaceholder')" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" @click="browseMysqlTlsFile('cert')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.mysqlClientCertBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <div class="flex items-center gap-1">
                        <Input v-model="mysqlClientKeyPath" class="flex-1" :placeholder="t('connection.mysqlClientKeyPlaceholder')" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="mysqlTlsMode === 'preferred' || mysqlTlsMode === 'disabled'" @click="browseMysqlTlsFile('key')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.mysqlClientKeyBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ t("connection.mysqlClientCertHint") }}
                      </p>
                    </div>
                  </div>
                </template>

                <template v-if="supportsPostgresTlsOptions">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.postgresSslMode") }}</Label>
                    <Select v-model="postgresTlsMode">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="disable">{{ t("connection.postgresSslModeDisable") }}</SelectItem>
                        <SelectItem value="prefer">{{ t("connection.postgresSslModePrefer") }}</SelectItem>
                        <SelectItem value="require">{{ t("connection.postgresSslModeRequire") }}</SelectItem>
                        <SelectItem value="verify-ca">{{ t("connection.postgresSslModeVerifyCa") }}</SelectItem>
                        <SelectItem value="verify-full">{{ t("connection.postgresSslModeVerifyFull") }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <ShieldCheck class="h-3.5 w-3.5" />
                        {{ t("connection.postgresServerCert") }}
                      </span>
                    </Label>
                    <div class="col-span-3 space-y-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="postgresRootCertPath" class="flex-1" :placeholder="t('connection.postgresRootCertPlaceholder')" :disabled="postgresTlsMode === 'disable'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="postgresTlsMode === 'disable'" @click="browsePostgresTlsFile('root')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.postgresRootCertBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ t("connection.postgresRootCertHint") }}
                      </p>
                    </div>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label :class="connectionLabelSmallPaddedClass">
                      <span class="inline-flex items-center justify-end gap-1">
                        <KeyRound class="h-3.5 w-3.5" />
                        {{ t("connection.postgresClientCert") }}
                      </span>
                    </Label>
                    <div class="col-span-3 grid gap-2">
                      <div class="flex items-center gap-1">
                        <Input v-model="postgresClientCertPath" class="flex-1" :placeholder="t('connection.postgresClientCertPlaceholder')" :disabled="postgresTlsMode === 'disable'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="postgresTlsMode === 'disable'" @click="browsePostgresTlsFile('cert')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.postgresClientCertBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <div class="flex items-center gap-1">
                        <Input v-model="postgresClientKeyPath" class="flex-1" :placeholder="t('connection.postgresClientKeyPlaceholder')" :disabled="postgresTlsMode === 'disable'" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="postgresTlsMode === 'disable'" @click="browsePostgresTlsFile('key')">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.postgresClientKeyBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ t("connection.postgresClientCertHint") }}
                      </p>
                    </div>
                  </div>
                </template>

                <div v-if="supportsCaCertificatePath" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.caCertPath") }}</Label>
                  <div class="col-span-3 flex items-center gap-1">
                    <Input v-model="form.ca_cert_path" class="flex-1" :placeholder="t('connection.caCertPathPlaceholder')" :disabled="!form.ssl" />
                    <Tooltip v-if="isDesktop">
                      <TooltipTrigger as-child>
                        <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="!form.ssl" @click="browseCaCertPath">
                          <FolderOpen class="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{{ t("connection.caCertPathBrowse") }}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="advanced" class="m-0 min-h-0 flex-1 overflow-hidden">
              <div class="connection-form-body grid h-full min-h-0 gap-4 overflow-y-auto pt-4 pr-2">
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.connectTimeout") }}</Label>
                  <Input v-model.number="form.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.queryTimeout") }}</Label>
                  <Input v-model.number="form.query_timeout_secs" type="number" min="0" max="300" step="1" class="col-span-3" />
                </div>
                <div v-show="form.db_type === 'mongodb'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.idleTimeout") }}</Label>
                  <Input v-model.number="form.idle_timeout_secs" type="number" min="0" max="600" step="1" class="col-span-3" />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.keepaliveInterval") }}</Label>
                  <div class="col-span-3 flex items-center gap-2">
                    <Switch v-model="keepaliveEnabled" />
                    <Input v-model.number="form.keepalive_interval_secs" type="number" min="1" max="3600" step="1" class="flex-1" :disabled="!keepaliveEnabled" />
                  </div>
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.readOnly") }}</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.read_only" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.readOnlyHint") }}</span>
                  </label>
                </div>
                <div class="grid grid-cols-4 items-start gap-4 rounded-[6px] border border-red-500/25 bg-red-500/[0.035] px-3 py-2.5">
                  <Label :class="[connectionLabelSmallClass, 'pt-0.5 text-red-700 dark:text-red-300']">
                    <span class="inline-flex items-center justify-end gap-1"><ShieldAlert class="h-3.5 w-3.5" />PROD</span>
                  </Label>
                  <div class="col-span-3 grid gap-2">
                    <div class="flex items-center justify-between gap-3">
                      <Label class="text-sm font-medium">{{ t("production.enable") }}</Label>
                      <Switch :model-value="productionProtectionEnabled" @update:model-value="setProductionProtectionEnabled" />
                    </div>
                    <p v-if="!productionProtectionEnabled" class="text-xs leading-5 text-muted-foreground">{{ t("production.disabledDescription") }}</p>
                    <template v-else>
                      <Label class="text-xs font-medium">{{ t("production.scope") }}</Label>
                      <Tabs v-model="productionScope" class="w-full">
                        <TabsList class="grid h-8 w-full grid-cols-2">
                          <TabsTrigger value="connection" class="text-xs">{{ t("production.allDatabases") }}</TabsTrigger>
                          <TabsTrigger value="databases" class="text-xs" :disabled="!canSelectProductionDatabases" :title="canSelectProductionDatabases ? undefined : t('production.singleDatabaseScopeHint')">{{ t("production.selectedDatabases") }}</TabsTrigger>
                        </TabsList>
                      </Tabs>
                      <p class="text-xs leading-5 text-muted-foreground">{{ productionScope === "connection" ? t("production.connectionDescription") : t("production.databaseDescription") }}</p>
                      <div v-if="productionScope === 'databases'" class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-3">
                          <Label class="text-xs font-medium">{{ t("production.databases") }}</Label>
                          <span class="text-xs text-muted-foreground">{{ productionDatabaseSummary }}</span>
                        </div>
                        <Button type="button" variant="outline" size="sm" class="justify-start" :disabled="isTesting || isSaving || isLoadingProductionDatabases || !hasRequiredConnectionTarget" @click="openProductionDatabasesPicker">
                          <Loader2 v-if="isLoadingProductionDatabases" class="mr-1.5 h-4 w-4 animate-spin" />
                          <ListFilter v-else class="mr-1.5 h-4 w-4" />
                          {{ t("production.selectDatabases") }}
                        </Button>
                      </div>
                    </template>
                  </div>
                </div>
                <div v-show="form.db_type === 'sqlserver'" class="grid grid-cols-4 items-start gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("connection.sqlServerLegacyCompatibilityMode") }}</Label>
                  <div class="col-span-3 flex flex-col gap-1">
                    <label class="flex h-5 cursor-pointer items-center gap-2">
                      <input type="checkbox" :checked="sqlServerLegacyCompatibilityModeEnabled" :disabled="agentInstallRunning" class="mr-0" @change="onSqlServerLegacyCompatibilityModeChange" />
                      <span class="text-xs text-foreground">{{ t("connection.sqlServerLegacyCompatibilityModeEnable") }}</span>
                    </label>
                    <p class="m-0 whitespace-pre-line text-xs leading-5 text-muted-foreground">
                      {{ t("connection.sqlServerLegacyCompatibilityModeHint") }}
                    </p>
                  </div>
                </div>
                <div v-show="form.db_type === 'redis'" class="grid grid-cols-4 items-center gap-4">
                  <Label :class="connectionLabelSmallClass">{{ t("settings.redisScanPageSize") }}</Label>
                  <div class="col-span-3 flex flex-col gap-1">
                    <Select :model-value="String(form.redis_scan_page_size ?? REDIS_SCAN_PAGE_SIZE_DEFAULT)" @update:model-value="form.redis_scan_page_size = Number($event)">
                      <SelectTrigger>
                        <SelectValue :placeholder="t('settings.redisScanPageSize')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="size in REDIS_SCAN_PAGE_SIZE_OPTIONS" :key="size" :value="String(size)">
                          {{ t("settings.redisScanPageSizeOption", { count: size }) }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ t("settings.redisScanPageSizeDescription") }}</p>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent v-if="canUseTransportLayers" value="transport" class="m-0 min-h-0 flex-1 overflow-hidden">
              <div class="connection-form-body grid h-full min-h-0 gap-4 overflow-y-auto overflow-x-hidden pt-4 pr-2">
                <div class="connection-label-wide-grid grid min-w-0 grid-cols-4 items-start gap-4">
                  <Label :class="connectionLabelSmallPaddedClass">{{ t("connection.sshHops") }}</Label>
                  <div class="col-span-3 grid min-w-0 gap-3">
                    <div class="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <template v-for="(segment, index) in transportPathSegments" :key="`${segment}-${index}`">
                        <span class="inline-block max-w-full truncate rounded border bg-muted/40 px-2 py-1">{{ segment }}</span>
                        <ChevronRight v-if="index < transportPathSegments.length - 1" class="h-3 w-3" />
                      </template>
                    </div>
                    <div class="grid min-w-0 gap-2">
                      <button
                        v-for="(hop, index) in transportLayers"
                        :key="hop.id"
                        type="button"
                        draggable="true"
                        class="flex min-h-10 items-center gap-2 rounded-md border px-2 text-left text-xs transition-colors"
                        :class="hop.id === selectedTransportLayer?.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'"
                        @click="selectedTransportLayerId = hop.id"
                        @dragstart="draggedTransportLayerId = hop.id"
                        @dragover.prevent
                        @drop="dropTransportLayer(hop.id)"
                      >
                        <GripVertical class="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span class="w-5 shrink-0 text-muted-foreground">{{ index + 1 }}</span>
                        <input v-model="hop.enabled" type="checkbox" class="mr-0" @click.stop />
                        <span class="min-w-0 flex-1 truncate">
                          {{ transportLayerDisplayName(hop, index) }}
                        </span>
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="index === 0" @click.stop="moveTransportLayer(hop.id, -1)">
                              <ArrowUp class="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.sshHopMoveUp") }}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="index === transportLayers.length - 1" @click.stop="moveTransportLayer(hop.id, 1)">
                              <ArrowDown class="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.sshHopMoveDown") }}</TooltipContent>
                        </Tooltip>
                      </button>
                    </div>
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="sm" @click="addSshTunnel">
                        <Plus class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.sshHopAdd") }}
                      </Button>
                      <Button type="button" variant="outline" size="sm" @click="addProxyTunnel">
                        <Plus class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.proxy") }}
                      </Button>
                      <Button type="button" variant="outline" size="sm" @click="addHttpTunnel">
                        <Plus class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.httpTunnelAdd") }}
                      </Button>
                      <Button v-if="selectedTransportLayer" type="button" variant="outline" size="sm" @click="duplicateTransportLayer(selectedTransportLayer)">
                        <Copy class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.sshHopDuplicate") }}
                      </Button>
                      <Button v-if="selectedTransportLayer" type="button" variant="outline" size="sm" @click="removeTransportLayer(selectedTransportLayer.id)">
                        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.sshHopDelete") }}
                      </Button>
                    </div>
                  </div>
                </div>

                <template v-if="selectedTransportLayer">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.sshHopName") }}</Label>
                    <Input v-model="selectedTransportLayer.name" class="col-span-3" :placeholder="t('connection.sshHopNamePlaceholder')" />
                  </div>
                  <div v-if="tunnelProfiles.length || selectedLayerProfileId" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">{{ t("connection.tunnelProfile") }}</Label>
                    <div class="col-span-3 flex min-w-0 items-center gap-2">
                      <Select :model-value="selectedLayerProfileId || 'custom'" @update:model-value="applyTunnelProfileSelection">
                        <SelectTrigger class="h-9 min-w-0 flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">{{ t("connection.tunnelProfileCustom") }}</SelectItem>
                          <SelectItem v-for="profile in tunnelProfiles" :key="profile.id" :value="profile.id">{{ tunnelProfileOptionLabel(profile) }}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button type="button" variant="outline" size="sm" class="shrink-0" @click="emit('openTunnelProfileSettings')">
                        {{ t("connection.tunnelProfileManage") }}
                      </Button>
                    </div>
                  </div>
                  <div v-if="selectedLayerProfileId" class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <div class="col-span-3 grid min-w-0 gap-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                      <template v-if="selectedLayerProfile">
                        <span class="truncate font-medium text-foreground">{{ selectedLayerProfile.name || tunnelProfileSummary(selectedLayerProfile) }}</span>
                        <span v-if="selectedLayerProfile.name && tunnelProfileSummary(selectedLayerProfile)" class="truncate">{{ tunnelProfileSummary(selectedLayerProfile) }}</span>
                        <span>{{ t("connection.tunnelProfileManaged") }}</span>
                      </template>
                      <span v-else class="text-red-500">{{ t("connection.tunnelProfileMissing") }}</span>
                    </div>
                  </div>
                  <div v-if="!selectedLayerProfileId" class="grid grid-cols-4 items-center gap-4">
                    <Label :class="connectionLabelSmallClass">Type</Label>
                    <Select :model-value="selectedTransportLayer.type" @update:model-value="(value: any) => changeSelectedTransportLayerType(value)">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ssh">SSH</SelectItem>
                        <SelectItem value="proxy">Proxy</SelectItem>
                        <SelectItem value="http_tunnel">{{ t("connection.httpTunnel") }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <template v-if="selectedSshLayer && !selectedLayerProfileId">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshHost") }}</Label>
                      <Input v-model="selectedSshLayer.host" class="col-span-2" list="ssh-config-host-aliases" :placeholder="t('connection.sshHostPlaceholder')" :disabled="selectedSshLayer.enabled === false" @change="applySshConfigHostAliasPrefill(selectedSshLayer!)" />
                      <datalist id="ssh-config-host-aliases">
                        <option v-for="alias in sshConfigHostAliases" :key="alias" :value="alias" />
                      </datalist>
                      <Input v-model.number="selectedSshLayer.port" type="number" min="1" max="65535" class="col-span-1" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshUser") }}</Label>
                      <Input v-model="selectedSshLayer.user" class="col-span-3" placeholder="root" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshAuthMethod") }}</Label>
                      <Select :model-value="selectedSshLayer.auth_method || 'password'" :disabled="selectedSshLayer.enabled === false" @update:model-value="updateSelectedSshAuthMethod">
                        <SelectTrigger class="col-span-3 h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="password">{{ t("connection.sshAuthMethodPassword") }}</SelectItem>
                          <SelectItem value="key">{{ t("connection.sshAuthMethodKey") }}</SelectItem>
                          <SelectItem value="none">{{ t("connection.sshAuthMethodNone") }}</SelectItem>
                          <SelectItem v-if="isLegacySshAgentMethod(selectedSshLayer)" value="agent" disabled>{{ t("connection.sshAuthMethodAgentLegacy") }}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div v-if="selectedSshLayer.auth_method === 'key'" class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshKeyPath") }}</Label>
                      <div class="col-span-3 flex items-center gap-1">
                        <Input v-model="selectedSshLayer.key_path" class="flex-1" placeholder="~/.ssh/id_rsa" :disabled="selectedSshLayer.enabled === false" />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="selectedSshLayer.enabled === false" @click="browseSshKeyPath(selectedSshLayer)">
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.sshKeyPathBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div v-if="selectedSshLayer.auth_method === 'key'" class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshKeyPassphrase") }}</Label>
                      <PasswordInput v-model="selectedSshLayer.key_passphrase" class="col-span-3" :placeholder="t('connection.sshKeyPassphrasePlaceholder')" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div v-if="!selectedSshLayer.auth_method || selectedSshLayer.auth_method === 'password'" class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshPassword") }}</Label>
                      <PasswordInput v-model="selectedSshLayer.password" class="col-span-3" :placeholder="t('connection.sshPasswordPlaceholder')" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div v-if="selectedSshLayer.auth_method === 'none'" class="grid grid-cols-4 items-center gap-4">
                      <span />
                      <p class="col-span-3 text-xs text-muted-foreground">{{ t("connection.sshAuthMethodNoneHint") }}</p>
                    </div>
                    <template v-if="isLegacySshAgentMethod(selectedSshLayer)">
                      <div class="grid grid-cols-4 items-center gap-4">
                        <span />
                        <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" v-model="selectedSshLayer.use_ssh_agent" class="mr-0" :disabled="selectedSshLayer.enabled === false" />
                          <span class="text-xs text-muted-foreground">{{ t("connection.sshUseAgent") }}</span>
                        </label>
                      </div>
                      <div v-if="selectedSshLayer.use_ssh_agent" class="grid grid-cols-4 items-center gap-4">
                        <Label :class="connectionLabelSmallClass">{{ t("connection.sshAgentSockPath") }}</Label>
                        <Input v-model="selectedSshLayer.ssh_agent_sock_path" class="col-span-3" :placeholder="t('connection.sshAgentSockPathPlaceholder')" :disabled="selectedSshLayer.enabled === false" />
                      </div>
                    </template>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <span />
                      <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" v-model="selectedSshLayer.expose_lan" class="mr-0" :disabled="selectedSshLayer.enabled === false" />
                        <span class="text-xs text-muted-foreground">{{ t("connection.sshExposeLan") }}</span>
                      </label>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.sshConnectTimeout") }}</Label>
                      <Input v-model.number="selectedSshLayer.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                  </template>
                  <template v-else-if="selectedProxyLayer && !selectedLayerProfileId">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.proxyType") }}</Label>
                      <Select :model-value="selectedProxyLayer.proxy_type || 'socks5'" :disabled="selectedProxyLayer.enabled === false" @update:model-value="updateSelectedProxyType">
                        <SelectTrigger class="col-span-3 h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="socks5">SOCKS5</SelectItem>
                          <SelectItem value="http">HTTP CONNECT</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.proxyHost") }}</Label>
                      <Input v-model="selectedProxyLayer.host" class="col-span-2" placeholder="127.0.0.1" :disabled="selectedProxyLayer.enabled === false" />
                      <Input v-model.number="selectedProxyLayer.port" type="number" class="col-span-1" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.proxyUsername") }}</Label>
                      <Input v-model="selectedProxyLayer.username" class="col-span-3" :placeholder="t('connection.proxyUsernamePlaceholder')" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.proxyPassword") }}</Label>
                      <PasswordInput v-model="selectedProxyLayer.password" class="col-span-3" :placeholder="t('connection.proxyPasswordPlaceholder')" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                  </template>
                  <template v-else-if="selectedHttpTunnelLayer && !selectedLayerProfileId">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.httpTunnelUrl") }}</Label>
                      <Input v-model="selectedHttpTunnelLayer.url" class="col-span-3" placeholder="https://dbx.example.com/dbx_tunnel.php" :disabled="selectedHttpTunnelLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.httpTunnelToken") }}</Label>
                      <PasswordInput v-model="selectedHttpTunnelLayer.token" class="col-span-3" :placeholder="t('connection.httpTunnelTokenPlaceholder')" :disabled="selectedHttpTunnelLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label :class="connectionLabelSmallClass">{{ t("connection.httpTunnelConnectTimeout") }}</Label>
                      <Input v-model.number="selectedHttpTunnelLayer.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" :disabled="selectedHttpTunnelLayer.enabled === false" />
                    </div>
                  </template>
                </template>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter class="flex min-w-0 shrink-0 items-center gap-2 sm:flex-nowrap">
          <div class="mr-auto flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden">
            <Button v-if="!editingId" variant="outline" class="shrink-0" :disabled="isSaving" @click="backToDatabasePicker">
              <ArrowLeft class="h-4 w-4" />
              {{ t("connection.back") }}
            </Button>
            <template v-if="testResult">
              <span class="block min-w-0 flex-1 basis-0 truncate text-xs" :class="testResult.ok ? 'text-green-600' : 'text-red-600'" :title="testResultMessage" role="status" aria-live="polite">
                {{ testResultMessage }}
              </span>
              <Button v-if="!testResult.ok" variant="ghost" size="icon-xs" class="h-5 w-5 shrink-0" :title="t('connection.copyTestResult')" :aria-label="t('connection.copyTestResult')" @click="copyTestResult">
                <Copy class="h-3 w-3" />
              </Button>
            </template>
          </div>
          <Button v-if="canChooseVisibleDatabases" variant="outline" class="shrink-0" :disabled="isTesting || isSaving || isLoadingVisibleDatabases || !hasRequiredConnectionTarget" @click="openVisibleDatabasesPicker">
            <Loader2 v-if="isLoadingVisibleDatabases" class="mr-1.5 h-4 w-4 animate-spin" />
            <ListFilter v-else class="mr-1.5 h-4 w-4" />
            {{ hasVisibleObjectFilter ? visibleObjectSummary : visibleFilterUsesSchemas ? t("contextMenu.configureVisibleObjects") : t("contextMenu.selectVisibleDatabases") }}
          </Button>
          <Button v-if="canChooseVisibleSchemas && !visibleFilterUsesSchemas && hasVisibleSchemaFilter" variant="outline" class="shrink-0" :disabled="isTesting || isSaving || isLoadingVisibleSchemas || !hasRequiredConnectionTarget" @click="openVisibleSchemasPicker">
            <Loader2 v-if="isLoadingVisibleSchemas" class="mr-1.5 h-4 w-4 animate-spin" />
            <ListFilter v-else class="mr-1.5 h-4 w-4" />
            {{ visibleSchemaSummary }}
          </Button>
          <Button variant="outline" class="shrink-0" :disabled="isTesting || isSaving" @click="testConnection">
            {{ isTesting ? t("connection.testing") : t("connection.test") }}
          </Button>
          <Button class="shrink-0" @click="save" :disabled="isSaving || !hasRequiredConnectionTarget">
            {{ isSaving ? t("common.loading") : editingId || isJdbcConnection ? t("connection.save") : t("connection.saveAndConnect") }}
          </Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>

  <Dialog :open="showAgentInstallDialog" @update:open="setAgentInstallDialogOpen">
    <DialogContent class="sm:max-w-[520px]" @interact-outside.prevent @escape-key-down.prevent>
      <DialogHeader>
        <DialogTitle>{{ agentInstallError ? "驱动安装失败" : "正在安装驱动" }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <div class="rounded-lg border bg-muted/20 p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{{ agentInstallLabel || agentInstallDriverKey }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ agentInstallProgressLabel }}</div>
            </div>
            <Loader2 v-if="agentInstallRunning && !agentInstallError" class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          </div>
          <div v-if="!agentInstallError" class="mt-4 h-2 overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full bg-primary transition-all" :class="{ 'animate-pulse': agentInstallPercent === null }" :style="{ width: `${agentInstallPercent ?? 35}%` }" />
          </div>
        </div>

        <div v-if="agentInstallError" class="space-y-2">
          <div class="text-sm font-medium text-destructive">完整错误</div>
          <pre class="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs leading-5 text-destructive">{{ agentInstallError }}</pre>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button v-if="agentInstallError" variant="outline" @click="copyAgentInstallError">
          <Copy class="mr-1.5 h-3.5 w-3.5" />
          复制错误
        </Button>
        <Button :disabled="!canCloseAgentInstallDialog" @click="showAgentInstallDialog = false">
          {{ agentInstallError ? "关闭" : "安装中..." }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showConnectionErrorDialog">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>连接失败</DialogTitle>
      </DialogHeader>

      <div class="space-y-2">
        <div class="text-sm text-muted-foreground">完整错误信息</div>
        <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs leading-5 text-destructive">{{ connectionErrorDetail }}</pre>
      </div>

      <DialogFooter class="gap-2">
        <Button v-if="showJdbcDependencyDriverManagerAction" variant="outline" @click="openJdbcDriverManagerFromError">
          <FolderOpen class="mr-1.5 h-3.5 w-3.5" />
          {{ t("toolbar.driverManager") }}
        </Button>
        <Button variant="outline" @click="copyConnectionErrorDetail">
          <Copy class="mr-1.5 h-3.5 w-3.5" />
          复制错误
        </Button>
        <Button @click="showConnectionErrorDialog = false">关闭</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showVisibleDatabasesDialog">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t(visibleObjectTitleKey) }}</DialogTitle>
        <p class="text-sm text-muted-foreground">
          {{ t(visibleObjectDescriptionKey, { connection: form.name || selectedProfile().label }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="visibleDatabaseSearchText" :placeholder="t(visibleObjectSearchPlaceholderKey)" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {{
            t(visibleObjectSelectedCountKey, {
              selected: visibleDatabaseSelectedCount,
              total: visibleDatabaseTotalCount,
            })
          }}
        </span>
        <div class="flex items-center gap-2">
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingVisibleDatabases" @click="selectAllVisibleDatabases">
            {{ t("visibleDatabases.selectAll") }}
          </button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingVisibleDatabases" @click="clearVisibleDatabaseSelection">
            {{ t("visibleDatabases.clear") }}
          </button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingVisibleDatabases" @click="showAllVisibleDatabases">
            {{ t("visibleDatabases.showAll") }}
          </button>
        </div>
      </div>
      <p v-if="!isLoadingVisibleDatabases && !visibleDatabaseError && !visibleDatabaseCanSave" class="text-xs text-destructive">
        {{ t(visibleObjectEmptySelectionKey) }}
      </p>

      <label v-if="visibleDatabaseHasSystemDatabases" class="flex h-8 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
        <input v-model="visibleDatabaseShowSystem" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError" />
        <span>{{ t("visibleDatabases.showSystemDatabases") }}</span>
      </label>

      <div class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingVisibleDatabases" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="visibleDatabaseError" class="p-3 text-sm text-destructive">
          {{ t(visibleObjectLoadFailedKey, { message: visibleDatabaseError }) }}
        </div>
        <div v-else-if="!filteredVisibleDatabaseNames.length" class="p-3 text-sm text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
        <template v-else>
          <button
            v-for="database in filteredVisibleDatabaseNames"
            :key="database"
            type="button"
            class="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
            @click="toggleVisibleDatabase(database)"
          >
            <CheckSquare v-if="visibleDatabaseSelection.has(database)" class="h-4 w-4 shrink-0 text-primary" />
            <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ database }}</span>
          </button>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="showVisibleDatabasesDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError || !visibleDatabaseCanSave" @click="saveVisibleDatabaseSelection">
          {{ t(visibleObjectSaveKey) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showProductionDatabasesDialog">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("production.databasePickerTitle") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">
          {{ t("production.databasePickerDescription", { connection: form.name || selectedProfile().label }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="productionDatabaseSearchText" :placeholder="t('production.databaseSearchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t("production.databasesSelectedCount", { selected: productionDatabaseSelectedCount, total: productionDatabaseNames.length }) }}</span>
        <div class="flex items-center gap-2">
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" @click="selectAllProductionDatabases">
            {{ t("visibleDatabases.selectAll") }}
          </button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" @click="clearProductionDatabaseSelection">
            {{ t("visibleDatabases.clear") }}
          </button>
        </div>
      </div>
      <p v-if="!isLoadingProductionDatabases && !productionDatabaseError && !productionDatabaseCanSave" class="text-xs text-destructive">
        {{ t("production.databaseSelectionRequired") }}
      </p>

      <div class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingProductionDatabases" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="productionDatabaseError" class="flex h-full flex-col items-start justify-center gap-3 p-3 text-sm text-destructive">
          <p>{{ t("production.databaseLoadFailed", { message: productionDatabaseError }) }}</p>
          <Button type="button" variant="outline" size="sm" @click="reloadProductionDatabases">
            <RefreshCw class="mr-1.5 h-3.5 w-3.5" />
            {{ t("production.retry") }}
          </Button>
        </div>
        <div v-else-if="!filteredProductionDatabaseNames.length" class="p-3 text-sm text-muted-foreground">
          {{ productionDatabaseNames.length ? t("grid.noSearchResults") : t("production.noDatabasesAvailable") }}
        </div>
        <template v-else>
          <button
            v-for="database in filteredProductionDatabaseNames"
            :key="database"
            type="button"
            class="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
            @click="toggleProductionDatabase(database)"
          >
            <CheckSquare v-if="productionDatabaseSelection.has(database)" class="h-4 w-4 shrink-0 text-primary" />
            <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ database }}</span>
          </button>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="showProductionDatabasesDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="isLoadingProductionDatabases || !!productionDatabaseError || !productionDatabaseCanSave" @click="saveProductionDatabaseSelection">
          {{ t("visibleDatabases.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <VisibleSchemasDialog
    v-model:open="showVisibleSchemasDialog"
    draft-mode
    :connection-id="''"
    :connection-name="form.name || selectedProfile().label"
    :database="visibleSchemasDatabaseKey"
    :draft-schema-names="visibleSchemaNames"
    :draft-initial-selection="visibleSchemaInitialSelection"
    :draft-loading="isLoadingVisibleSchemas"
    :draft-error="visibleSchemaError"
    @draft:save="handleDraftSchemasSave"
    @draft:show-all="handleDraftSchemasShowAll"
  />
</template>

<style>
.connection-dialog-content {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 2rem);
}

@media (min-width: 640px) {
  .connection-db-picker-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
  }
}

@media (min-width: 1024px) {
  .connection-db-picker-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr)) !important;
  }
}

.connection-db-picker-option {
  color: var(--foreground);
}

.connection-db-picker-option--selected {
  border-color: rgb(23, 23, 23);
  background-color: rgba(23, 23, 23, 0.08);
  box-shadow: 0 0 0 1px rgba(23, 23, 23, 0.24);
  color: rgb(10, 10, 10);
}

.connection-db-picker-option--selected:hover {
  background-color: rgba(23, 23, 23, 0.12);
}

.dark .connection-db-picker-option--selected {
  border-color: rgb(208, 208, 214);
  background-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.22);
  color: rgb(221, 221, 226);
}

.dark .connection-db-picker-option--selected:hover {
  background-color: rgba(255, 255, 255, 0.12);
}

.connection-dialog-content[data-wide="true"] .grid.grid-cols-4 {
  grid-template-columns: minmax(5.5rem, 0.7fr) repeat(3, minmax(0, 1fr));
}

.connection-dialog-content[data-wide="true"] .connection-form-body {
  width: min(100%, 36rem);
  margin-inline: auto;
}
</style>
