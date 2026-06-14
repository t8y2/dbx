<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { ConnectionConfig, DatabaseType, JdbcDriverInfo, JdbcMavenBundleInfo, ProxyTunnelConfig, SshTunnelConfig, TransportLayerConfig } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { applyParsedConnectionUrl, normalizeMongoConnectionString, parseConnectionUrl } from "@/lib/connectionUrl";
import type { ConnectionDeepLinkDraft } from "@/lib/connectionDeepLink";
import { connectionUrlPlaceholder as getUrlPlaceholder } from "@/lib/connectionPresentation";
import { h2ConnectionModeForConfig, h2FileJdbcUrl, h2FilePathFromJdbcUrl, type H2ConnectionMode } from "@/lib/h2Connection";
import { isLocalFileTypeDb } from "@/lib/connectionFile";
import { mongodbAuthFailureHint, mongoUrlParam, setMongoUrlParam } from "@/lib/mongoConnectionOptions";
import { copyToClipboard } from "@/lib/clipboard";
import { showAgentDriverInstallHint, type AgentDriverInstallState } from "@/lib/agentDriverInstallHint";
import { ArrowLeft, ArrowDown, ArrowUp, CheckSquare, ChevronRight, Copy, ExternalLink, FilePlus2, FolderOpen, GripVertical, Grid3X3, KeyRound, Link2, List, ListFilter, Loader2, Pipette, Plus, Search, ShieldCheck, Square, Trash2 } from "@lucide/vue";
import { buildDraftVisibleDatabasesConnectionId, connectionCanChooseVisibleDatabases, initialVisibleDatabaseSelection, visibleDatabaseSelectionIsStale } from "@/lib/connectionVisibleDatabases";
import { canSaveVisibleDatabaseSelection, filterDatabaseNamesForConnection, isSystemDatabaseName, normalizeVisibleDatabaseSelection } from "@/lib/visibleDatabases";

type DbOption = { value: string; label: string };
type DbCategory = { key: string; title: string; options: DbOption[] };
type DialogStep = "select" | "config";
type DbPickerView = "icon" | "list";
type ConfigTab = "connection" | "advanced" | "tls" | "transport";
type JdbcDriverSelectItem = {
  id: string;
  label: string;
  paths: string[];
};

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

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const open = defineModel<boolean>("open", { default: false });
const isDesktop = isTauriRuntime();

const props = defineProps<{
  editConfig?: ConnectionConfig;
  prefillConfig?: ConnectionDeepLinkDraft | null;
}>();

const emit = defineEmits<{
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
  openDriverStore: [];
}>();

const store = useConnectionStore();
const isTesting = ref(false);
const isSaving = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);
const editingId = ref<string | null>(null);
const showVisibleDatabasesDialog = ref(false);
const isLoadingVisibleDatabases = ref(false);
const visibleDatabaseNames = ref<string[]>([]);
const visibleDatabaseSelection = ref<Set<string>>(new Set());
const visibleDatabaseSearchText = ref("");
const visibleDatabaseError = ref("");
const visibleDatabaseShowSystem = ref(false);
let testRunId = 0;

const defaultForm = (): ConnectionForm => ({
  name: "",
  db_type: "mysql",
  driver_profile: "mysql",
  driver_label: "MySQL",
  url_params: "",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  database: undefined,
  color: "",
  transport_layers: [],
  connect_timeout_secs: 5,
  query_timeout_secs: 30,
  idle_timeout_secs: 60,
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
  etcd_endpoints: "",
  gbase_server: "",
  read_only: false,
  visible_databases: undefined,
});

function defaultSshTunnel(): SshTunnelConfig {
  return {
    id: uuid(),
    name: "",
    enabled: true,
    host: "",
    port: 22,
    user: "",
    password: "",
    key_path: "",
    key_passphrase: "",
    connect_timeout_secs: 5,
    expose_lan: false,
    use_ssh_agent: false,
  };
}

function normalizeSshTunnel(hop: Partial<SshTunnelConfig>): SshTunnelConfig {
  return {
    id: hop.id || uuid(),
    name: hop.name || "",
    enabled: hop.enabled !== false,
    host: hop.host || "",
    port: Number(hop.port) || 22,
    user: hop.user || "",
    password: hop.password || "",
    key_path: hop.key_path || "",
    key_passphrase: hop.key_passphrase || "",
    connect_timeout_secs: Number(hop.connect_timeout_secs) || 5,
    expose_lan: !!hop.expose_lan,
    use_ssh_agent: !!hop.use_ssh_agent,
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
  };
}

function normalizeTransportLayer(layer: Partial<TransportLayerConfig>): TransportLayerConfig {
  if (layer.type === "proxy") {
    return { type: "proxy", ...normalizeProxyTunnel(layer) };
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
      }),
    ];
  }
  return [];
}

const form = ref(defaultForm());
const selectedTransportLayerId = ref<string | null>(null);
const draggedTransportLayerId = ref<string | null>(null);
const selectedType = ref("mysql");
const customDriverName = ref("");
const mongoUseUrl = ref(false);
const jdbcDriverPathsInput = ref("");
const jdbcDrivers = ref<JdbcDriverInfo[]>([]);
const jdbcMavenBundles = ref<JdbcMavenBundleInfo[]>([]);
const agentDrivers = ref<AgentDriverInstallState[]>([]);
const selectedJdbcDriverPath = ref("");
const jdbcManualClasspathOpen = ref(false);
const connectionUrlInput = ref("");
const oceanbaseSubMode = ref<"mysql" | "oracle">("mysql");
const h2ConnectionMode = ref<H2ConnectionMode>("file");
const dialogStep = ref<DialogStep>("select");
const dbPickerView = ref<DbPickerView>("icon");
const dbSearchQuery = ref("");
const configTab = ref<ConfigTab>("connection");

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
  const bundles = jdbcMavenBundles.value.map((bundle) => ({
    id: `maven:${bundle.id}`,
    label: bundle.coordinate,
    paths: bundle.artifacts.map((artifact) => artifact.path),
  }));
  const manual = jdbcDrivers.value
    .filter((driver) => !driver.bundle_id)
    .map((driver) => ({
      id: `manual:${driver.path}`,
      label: driver.name,
      paths: [driver.path],
    }));
  return [...bundles, ...manual].sort((left, right) => left.label.localeCompare(right.label));
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
  duckdb: { type: "duckdb", port: 0, user: "", label: "DuckDB", icon: "duckdb" },
  access: { type: "access", port: 0, user: "", label: "Microsoft Access", icon: "access" },
  mongodb: { type: "mongodb", port: 27017, user: "", label: "MongoDB", icon: "mongodb" },
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
  mariadb: { type: "mysql", port: 3306, user: "root", label: "MariaDB", icon: "mariadb" },
  tidb: { type: "mysql", port: 4000, user: "root", label: "TiDB", icon: "tidb" },
  oceanbase: { type: "mysql", port: 2881, user: "root", label: "OceanBase", icon: "oceanbase" },
  "oceanbase-oracle": {
    type: "oceanbase-oracle",
    port: 2881,
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
  dm: { type: "dameng", port: 5236, user: "SYSDBA", label: "DM (Dameng)", icon: "dm" },
  h2: { type: "h2", port: 9092, user: "sa", label: "H2", icon: "h2" },
  snowflake: { type: "snowflake", port: 443, user: "", label: "Snowflake", icon: "snowflake" },
  trino: { type: "trino", port: 8080, user: "", label: "Trino", icon: "trino" },
  hive: { type: "hive", port: 10000, user: "", label: "Apache Hive", icon: "hive" },
  db2: { type: "db2", port: 50000, user: "db2inst1", label: "IBM DB2", icon: "db2" },
  informix: { type: "informix", port: 9088, user: "informix", label: "Informix", icon: "informix" },
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
  jdbc: { type: "jdbc", port: 0, user: "", label: "JDBC", icon: "jdbc" },
  tdengine: { type: "tdengine", port: 6041, user: "root", label: "TDengine", icon: "tdengine" },
  xugu: { type: "xugu", port: 5138, user: "", label: "虚谷 XuguDB", icon: "xugu" },
  iotdb: { type: "iotdb", port: 6667, user: "root", label: "Apache IoTDB", icon: "iotdb" },
  etcd: { type: "etcd", port: 2379, user: "", label: "etcd", icon: "etcd" },
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
  if (config.db_type === "dameng") return "dm";
  if (config.db_type === "oceanbase-oracle") return "oceanbase";
  return config.db_type;
}

function selectedProfile() {
  return driverProfiles[selectedType.value] ?? driverProfiles.mysql;
}

function isCustomCompatibleProfile() {
  return selectedType.value === "custom_mysql" || selectedType.value === "custom_postgres";
}

function applyProfile(val: string, preserveConnectionFields = false) {
  const profile = driverProfiles[val];
  if (!profile) return;

  selectedType.value = val;
  form.value.db_type = profile.type;
  form.value.driver_profile = val;
  form.value.driver_label = isCustomCompatibleProfile() ? customDriverName.value.trim() || profile.label : profile.label;

  if (!preserveConnectionFields) {
    form.value.port = profile.port;
    form.value.username = profile.user;
    form.value.url_params = profile.urlParams || "";
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
    }
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
  () => props.editConfig,
  (config) => {
    if (config) {
      const legacyConfig = config as LegacyConnectionConfig;
      const profile = profileForConfig(config);
      editingId.value = config.id;
      const profileConfig = driverProfiles[profile];
      form.value = {
        name: config.name,
        db_type: profileConfig?.type || config.db_type,
        driver_profile: profile,
        driver_label: config.driver_label || driverProfiles[profile]?.label || config.db_type,
        url_params: config.url_params || "",
        host: config.db_type === "h2" ? config.host || h2FilePathFromJdbcUrl(config.connection_string) : config.host,
        port: profile === "tdengine" && (config.port === 0 || config.port === 6030) ? 6041 : config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        color: config.color || "",
        transport_layers: transportLayersForConfig(legacyConfig),
        connect_timeout_secs: config.connect_timeout_secs || 5,
        query_timeout_secs: config.query_timeout_secs ?? 30,
        idle_timeout_secs: config.idle_timeout_secs ?? 60,
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
        etcd_endpoints: config.etcd_endpoints || "",
        read_only: config.read_only || false,
        visible_databases: config.visible_databases,
      };
      h2ConnectionMode.value = h2ConnectionModeForConfig(config);
      customColorInput.value = config.color || "";
      selectedTransportLayerId.value = form.value.transport_layers?.[0]?.id || null;
      selectedType.value = profile;
      if (profile === "oceanbase") {
        oceanbaseSubMode.value = config.driver_profile === "oceanbase-oracle" ? "oracle" : "mysql";
      }
      if (profile === "gbase8a" || profile === "gbase8s") {
        selectedType.value = "gbase";
      }
      mongoUseUrl.value = !!config.connection_string;
      jdbcDriverPathsInput.value = (config.jdbc_driver_paths || []).join("\n");
      customDriverName.value = isCustomCompatibleProfile() ? config.driver_label || "" : "";
      dialogStep.value = "config";
      configTab.value = "connection";
    } else {
      editingId.value = null;
      form.value = defaultForm();
      selectedTransportLayerId.value = null;
      selectedType.value = "mysql";
      customDriverName.value = "";
      oceanbaseSubMode.value = "mysql";
      h2ConnectionMode.value = "file";
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

const databaseLabel = computed(() => (form.value.db_type === "oracle" ? t("connection.serviceName") : t("connection.database")));

const databasePlaceholder = computed(() => {
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
const transportPathSegments = computed(() => {
  const layers = transportLayers.value.filter((layer) => layer.enabled !== false);
  return [
    "DBX",
    ...layers.map((layer, index) => {
      const fallback = layer.type === "proxy" ? `Proxy ${index + 1}` : `SSH ${index + 1}`;
      return layer.name?.trim() || layer.host?.trim() || fallback;
    }),
    form.value.host || "Database",
  ];
});

function defaultDatabaseForProfile() {
  if (form.value.db_type === "redshift") return "dev";
  if (form.value.db_type === "gaussdb") return "postgres";
  if (form.value.db_type === "kwdb") return "defaultdb";
  if (form.value.db_type === "databend") return "default";
  if (selectedType.value === "cockroachdb") return "defaultdb";
  if (form.value.db_type === "highgo") return "highgo";
  if (form.value.db_type === "yashandb") return "yasdb";
  if (form.value.db_type === "postgres" || form.value.db_type === "kingbase" || form.value.db_type === "vastbase") return "postgres";
  if (form.value.db_type === "sqlserver") return "master";
  if (form.value.db_type === "oracle") return "ORCL";
  if (form.value.db_type === "h2" && h2ConnectionMode.value === "tcp") return "test";
  return "";
}

function onDbTypeChange(val: string) {
  customDriverName.value = "";
  applyProfile(val, !!editingId.value);
  resetTestState();
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
  access: "access",
  redis: "redis",
  mongodb: "mongodb",
  duckdb: "duckdb",
  clickhouse: "clickhouse",
  sqlserver: "sqlserver",
  oracle: "oracle",
  elasticsearch: "elasticsearch",
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
  dm: "dm",
  h2: "h2",
  snowflake: "snowflake",
  trino: "trino",
  hive: "hive",
  db2: "db2",
  informix: "informix",
  iris: "iris",
  neo4j: "neo4j",
  cassandra: "cassandra",
  bigquery: "bigquery",
  kylin: "kylin",
  sundb: "sundb",
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
  { value: "dm", label: "DM (Dameng)" },
  { value: "opengauss", label: "openGauss" },
  { value: "turso", label: "Turso" },
  { value: "duckdb", label: "DuckDB" },
  { value: "rqlite", label: "RQLite" },
  { value: "access", label: "Microsoft Access" },
  { value: "mariadb", label: "MariaDB" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "gaussdb", label: "GaussDB" },
  { value: "kwdb", label: "KWDB" },
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
  { value: "hive", label: "Hive" },
  { value: "db2", label: "DB2" },
  { value: "informix", label: "Informix" },
  { value: "neo4j", label: "Neo4j" },
  { value: "cassandra", label: "Cassandra" },
  { value: "bigquery", label: "BigQuery" },
  { value: "kylin", label: "Kylin" },
  { value: "sundb", label: "SunDB" },
  { value: "xugu", label: "虚谷 XuguDB" },
  { value: "iotdb", label: "Apache IoTDB" },
  { value: "etcd", label: "etcd" },
  { value: "influxdb", label: "InfluxDB" },
  { value: "iris", label: "IRIS" },
  { value: "jdbc", label: "JDBC" },
  { value: "manticoresearch", label: "Manticore Search" },
  { value: "custom_mysql", label: "Custom (MySQL)" },
  { value: "custom_postgres", label: "Custom (PostgreSQL)" },
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
const isJdbcConnection = computed(() => form.value.db_type === "jdbc");
const isH2FileMode = computed(() => form.value.db_type === "h2" && h2ConnectionMode.value === "file");
const usesLocalFilePathInput = computed(() => isLocalFileTypeDb(form.value.db_type) && (form.value.db_type !== "h2" || isH2FileMode.value));

const connectionUrlPlaceholder = computed(() => getUrlPlaceholder(form.value.db_type));
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
const tlsCapableDatabaseTypes = new Set<DatabaseType>(["mysql", "postgres", "redshift", "gaussdb", "kwdb", "opengauss", "redis", "etcd", "clickhouse", "elasticsearch", "influxdb"]);
const supportsTlsToggle = computed(() => tlsCapableDatabaseTypes.has(form.value.db_type));
const supportsCaCertificatePath = computed(() => form.value.db_type === "clickhouse");
const supportsGenericUrlParams = computed(() => form.value.db_type !== "manticoresearch");
const bareMysqlProfiles = new Set(["doris", "starrocks", "selectdb", "oceanbase"]);
const supportsMysqlTlsOptions = computed(() => form.value.db_type === "mysql" && !bareMysqlProfiles.has(selectedType.value));
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
  get: () => {
    const value = normalizePostgresSslMode(getUrlParam(form.value.url_params, "sslmode"));
    if (value) return value;
    return form.value.ssl ? "require" : "disable";
  },
  set: (value: string) => {
    form.value.ssl = value !== "disable";
    form.value.url_params = setUrlParam(form.value.url_params, "sslmode", value === "prefer" ? "" : value);
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
const canUseTransportLayers = computed(() => form.value.db_type !== "sqlite" && form.value.db_type !== "access" && !isH2FileMode.value);
const shouldShowAgentDriverInstallHint = computed(() => showAgentDriverInstallHint(form.value.db_type, agentDrivers.value, form.value.driver_profile));
const canChooseVisibleDatabases = computed(() => connectionCanChooseVisibleDatabases(form.value));
const hasVisibleDatabaseFilter = computed(() => Array.isArray(form.value.visible_databases));
const visibleDatabaseSummary = computed(() => {
  const configured = form.value.visible_databases;
  if (!Array.isArray(configured)) return t("visibleDatabases.showAll");
  return t("visibleDatabases.selectedCount", { selected: configured.length, total: visibleDatabaseNames.value.length });
});
const listedVisibleDatabaseNames = computed(() => {
  const connection = connectionConfigSnapshotForVisibleDatabases();
  if (visibleDatabaseShowSystem.value) return visibleDatabaseNames.value;
  return filterDatabaseNamesForConnection(visibleDatabaseNames.value, connection);
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
  const connection = connectionConfigSnapshotForVisibleDatabases();
  return visibleDatabaseNames.value.some((database) => isSystemDatabaseName(connection.db_type, database));
});
const testResultMessage = computed(() => {
  if (!testResult.value) return "";
  return testResult.value.ok ? t("connection.testSuccess") : testResult.value.message;
});
const hasRequiredConnectionTarget = computed(() => {
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
  try {
    const config = connectionConfigForSubmit(editingId.value || uuid());
    const msg = await api.testConnection(config);
    if (runId !== testRunId) return;
    testResult.value = { ok: true, message: msg };
  } catch (e: any) {
    if (runId !== testRunId) return;
    testResult.value = { ok: false, message: mongodbAuthFailureHint(String(e)) };
  } finally {
    if (runId === testRunId) {
      isTesting.value = false;
    }
  }
}

function applyConnectionUrlToForm(input: string): boolean {
  try {
    const parsed = parseConnectionUrl(input, selectedType.value);
    form.value = applyParsedConnectionUrl(form.value, parsed);
    selectedType.value = parsed.driverProfile;
    customDriverName.value = isCustomCompatibleProfile() ? parsed.driverLabel : "";
    mongoUseUrl.value = !!parsed.useMongoUrl;
    if (!form.value.name.trim()) {
      form.value.name = parsed.database || parsed.host || parsed.driverLabel;
    }
    resetTestState();
    return true;
  } catch (e: any) {
    toast(t("connection.parseConnectionUrlFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

function ensureConnectionHostResolvedFromUrl(): boolean {
  if (form.value.host.trim()) return true;
  const url = connectionUrlInput.value.trim();
  if (!url) return true;
  return applyConnectionUrlToForm(url);
}

function generateConnectionName(): string {
  const label = selectedProfile().label;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${label}_${rand}`;
}

function connectionConfigForSubmit(id: string): ConnectionConfig {
  const config = { ...form.value, id } as LegacyConnectionConfig;
  if (!config.name?.trim()) {
    config.name = generateConnectionName();
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
  config.connect_timeout_secs = Number.isFinite(connectTimeout) && connectTimeout > 0 ? connectTimeout : 5;
  const queryTimeout = Number(config.query_timeout_secs);
  config.query_timeout_secs = Number.isFinite(queryTimeout) && queryTimeout >= 0 ? queryTimeout : 30;
  const idleTimeout = Number(config.idle_timeout_secs);
  config.idle_timeout_secs = Number.isFinite(idleTimeout) && idleTimeout >= 0 ? idleTimeout : 60;
  if (config.db_type === "manticoresearch") {
    config.url_params = "";
  }
  if (!config.one_time) config.one_time = undefined;
  if (!config.read_only) config.read_only = undefined;
  if (config.db_type === "mongodb" && !mongoUseUrl.value) {
    config.connection_string = undefined;
  } else if (config.db_type === "mongodb") {
    config.connection_string = normalizeMongoConnectionString(config.connection_string?.trim() || "");
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
  if (config.db_type !== "mysql" && config.db_type !== "clickhouse" && config.db_type !== "etcd") {
    config.ca_cert_path = undefined;
  } else {
    config.ca_cert_path = config.ca_cert_path?.trim() || "";
  }
  if (config.db_type === "jdbc") {
    config.host = "";
    config.port = 0;
    config.connection_string = config.connection_string?.trim() || "";
    config.jdbc_driver_class = config.jdbc_driver_class?.trim() || undefined;
    config.jdbc_driver_paths = jdbcDriverPathsInput.value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  }
  if (config.db_type === "h2") {
    if (h2ConnectionMode.value === "file") {
      const filePath = config.host?.trim() || h2FilePathFromJdbcUrl(config.connection_string);
      if (!filePath) {
        throw new Error(t("connection.h2FilePathRequired"));
      }
      config.host = filePath;
      config.port = 0;
      config.connection_string = h2FileJdbcUrl(filePath);
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
  config.visible_databases = Array.isArray(config.visible_databases) && config.visible_databases.length > 0 ? config.visible_databases : undefined;
  return config as ConnectionConfig;
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

  if (!ssl && getUrlParam(params, "require_ssl").toLowerCase() !== "true") return "preferred";
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
    return next;
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

function normalizePostgresSslMode(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "disable":
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full":
      return value.trim().toLowerCase();
    case "verify_identity":
    case "verify-identity":
      return "verify-full";
    default:
      return "";
  }
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

async function openVisibleDatabasesPicker() {
  if (!ensureConnectionHostResolvedFromUrl()) return;
  if (!canChooseVisibleDatabases.value || isLoadingVisibleDatabases.value) return;

  isLoadingVisibleDatabases.value = true;
  visibleDatabaseError.value = "";
  visibleDatabaseSearchText.value = "";
  const draftId = buildDraftVisibleDatabasesConnectionId(uuid());
  const draftConfig = {
    ...connectionConfigForSubmit(draftId),
    id: draftId,
    one_time: true,
  };

  try {
    await api.connectDb(draftConfig);
    const names = await loadVisibleDatabaseNames(draftId, draftConfig);
    visibleDatabaseNames.value = names;
    const initialSelection = initialVisibleDatabaseSelection(names, form.value.visible_databases, draftConfig);
    visibleDatabaseSelection.value = new Set(initialSelection);
    visibleDatabaseShowSystem.value = initialSelection.some((database) => isSystemDatabaseName(draftConfig.db_type, database));
    showVisibleDatabasesDialog.value = true;
  } catch (e: any) {
    visibleDatabaseNames.value = [];
    visibleDatabaseSelection.value = new Set();
    visibleDatabaseError.value = mongodbAuthFailureHint(String(e?.message || e));
    testResult.value = { ok: false, message: visibleDatabaseError.value };
  } finally {
    await api.disconnectDb(draftId).catch(() => undefined);
    isLoadingVisibleDatabases.value = false;
  }
}

async function loadVisibleDatabaseNames(connectionId: string, config: ConnectionConfig): Promise<string[]> {
  if (config.db_type === "oracle" || config.db_type === "dameng") {
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
  form.value.visible_databases = undefined;
  visibleDatabaseSelection.value = new Set();
  visibleDatabaseNames.value = [];
  showVisibleDatabasesDialog.value = false;
}

function saveVisibleDatabaseSelection() {
  if (!visibleDatabaseCanSave.value) return;
  form.value.visible_databases = normalizeVisibleDatabaseSelection([...visibleDatabaseSelection.value], visibleDatabaseNames.value);
  showVisibleDatabasesDialog.value = false;
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

function resetForm() {
  editingId.value = null;
  form.value = defaultForm();
  selectedTransportLayerId.value = null;
  draggedTransportLayerId.value = null;
  selectedType.value = "mysql";
  customDriverName.value = "";
  mongoUseUrl.value = false;
  oceanbaseSubMode.value = "mysql";
  jdbcDriverPathsInput.value = "";
  selectedJdbcDriverPath.value = "";
  connectionUrlInput.value = "";
  dialogStep.value = "select";
  dbPickerView.value = "icon";
  dbSearchQuery.value = "";
  configTab.value = "connection";
  resetVisibleDatabaseDraftState();
  resetTestState();
}

const submittedOneTimePrefillKey = ref<string | null>(null);

function oneTimePrefillKey(draft: ConnectionDeepLinkDraft) {
  return JSON.stringify([draft.name, draft.dbType, draft.driverProfile, draft.driverLabel, draft.host, draft.port, draft.username, draft.password, draft.database, draft.urlParams, draft.ssl, draft.connectionString, draft.oracleConnectionType, draft.useMongoUrl]);
}

function submitOneTimePrefill(draft: ConnectionDeepLinkDraft) {
  if (!draft.oneTime) return;
  const key = oneTimePrefillKey(draft);
  if (submittedOneTimePrefillKey.value === key) return;
  submittedOneTimePrefillKey.value = key;
  void nextTick(() => save());
}

function applyConnectionPrefill(draft: ConnectionDeepLinkDraft) {
  resetForm();
  applyProfile(draft.driverProfile);
  form.value = {
    ...form.value,
    db_type: draft.dbType,
    driver_profile: draft.driverProfile,
    driver_label: draft.driverLabel,
    host: draft.host ?? form.value.host,
    port: draft.port ?? form.value.port,
    username: draft.username ?? form.value.username,
    password: draft.password ?? form.value.password,
    database: draft.database ?? form.value.database,
    url_params: draft.urlParams ?? form.value.url_params,
    ssl: draft.ssl ?? form.value.ssl,
    connection_string: draft.connectionString ?? form.value.connection_string,
    oracle_connection_type: draft.oracleConnectionType ?? form.value.oracle_connection_type,
    one_time: draft.oneTime || undefined,
  };
  selectedType.value = draft.driverProfile;
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
  submitOneTimePrefill(draft);
}

watch(
  open,
  (value) => {
    if (!value) {
      submittedOneTimePrefillKey.value = null;
      resetForm();
      return;
    }
    if (!props.editConfig) {
      resetForm();
      if (props.prefillConfig) applyConnectionPrefill(props.prefillConfig);
    }
    if (!props.prefillConfig?.oneTime) {
      void loadJdbcDrivers();
      void loadAgentDrivers();
    }
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

function changeSelectedTransportLayerType(type: "ssh" | "proxy") {
  const selected = selectedTransportLayer.value;
  if (!selected || selected.type === type) return;
  const replacement: TransportLayerConfig = type === "proxy" ? { type: "proxy", ...defaultProxyTunnel(), id: selected.id, name: selected.name } : { type: "ssh", ...defaultSshTunnel(), id: selected.id, name: selected.name };
  form.value.transport_layers = transportLayers.value.map((layer) => (layer.id === selected.id ? replacement : layer));
  resetTestState();
}

function updateSelectedProxyType(value: unknown) {
  const layer = selectedProxyLayer.value;
  if (!layer) return;
  layer.proxy_type = value === "http" ? "http" : "socks5";
  resetTestState();
}

function validateTransportLayers(config: LegacyConnectionConfig) {
  const layers = config.transport_layers || [];
  layers.forEach((layer, index) => {
    if (layer.enabled === false) return;
    const label = layer.name?.trim() || t("connection.sshHopDefaultName", { index: index + 1 });
    if (!layer.host?.trim()) throw new Error(t("connection.sshHopInvalidHost", { hop: label }));
    const port = Number(layer.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(t("connection.sshHopInvalidPort", { hop: label }));
    }
    if (layer.type === "ssh") {
      if (!layer.user?.trim()) throw new Error(t("connection.sshHopInvalidUser", { hop: label }));
      if (!layer.password?.trim() && !layer.key_path?.trim() && !layer.use_ssh_agent) {
        throw new Error(t("connection.sshHopInvalidAuth", { hop: label }));
      }
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
  isSaving.value = true;
  resetTestState();
  try {
    if (editingId.value) {
      const updated = connectionConfigForSubmit(editingId.value);
      await store.updateConnection(updated);
      store.stopEditing();
    } else {
      const config = connectionConfigForSubmit(uuid());
      await store.addConnection(config);
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
          if (config.one_time) void store.removeConnection(config.id);
          emit("connectFailed", mongodbAuthFailureHint(String(e?.message || e)));
        });
      return;
    }
    open.value = false;
  } catch (e: any) {
    testResult.value = { ok: false, message: mongodbAuthFailureHint(String(e?.message || e)) };
  } finally {
    isSaving.value = false;
  }
}

const dialogTitle = ref("");
watch([() => editingId.value, () => open.value], () => {
  dialogTitle.value = editingId.value ? t("connection.editTitle") : t("connection.title");
});

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

async function browseDbFilePath() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filters =
      form.value.db_type === "duckdb"
        ? [{ name: "DuckDB", extensions: ["duckdb", "db"] }]
        : form.value.db_type === "access"
          ? [{ name: "Microsoft Access", extensions: ["accdb", "mdb"] }]
          : form.value.db_type === "h2"
            ? [{ name: "H2", extensions: ["db"] }]
            : [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }];
    const selected = await open({
      title: "Select Database File",
      multiple: false,
      filters,
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
    const [drivers, bundles] = await Promise.all([api.listJdbcDrivers(), api.listJdbcMavenBundles()]);
    jdbcDrivers.value = drivers;
    jdbcMavenBundles.value = bundles;
  } catch {
    jdbcDrivers.value = [];
    jdbcMavenBundles.value = [];
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

function onJdbcDriverSelect(id: any) {
  if (typeof id !== "string" || !id) return;
  const item = jdbcDriverSelectItemById.value.get(id);
  if (!item) return;
  selectedJdbcDriverPath.value = id;
  addJdbcDriverPaths(item.paths);
  jdbcManualClasspathOpen.value = false;
}

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
    <DialogContent :class="dialogStep === 'select' ? 'sm:max-w-[760px]' : 'sm:max-w-[560px]'" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ editingId ? t("connection.editTitle") : t("connection.title") }}</DialogTitle>
      </DialogHeader>

      <template v-if="dialogStep === 'select'">
        <div class="space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
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
          </div>

          <div class="max-h-[58vh] space-y-5 overflow-y-auto pr-2">
            <section v-for="category in filteredDbCategories" :key="category.key" class="space-y-2">
              <div class="flex items-center">
                <h3 v-if="category.title" class="text-sm font-medium">{{ category.title }}</h3>
              </div>

              <div v-if="dbPickerView === 'icon'" class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                <button
                  v-for="opt in category.options"
                  :key="opt.value"
                  type="button"
                  class="group flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border bg-background/70 p-3 text-center transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="selectedType === opt.value ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/30' : 'border-border'"
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
                  class="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left transition hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="selectedType === opt.value ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border'"
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

        <DialogFooter class="flex items-center gap-2">
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
        <div class="space-y-3">
          <Tabs v-model="configTab" class="min-h-0">
            <div class="flex items-center justify-between border-b pb-2">
              <TabsList>
                <TabsTrigger value="connection">{{ t("connection.basicTab") }}</TabsTrigger>
                <TabsTrigger v-if="supportsTlsToggle" value="tls">{{ t("connection.tlsTab") }}</TabsTrigger>
                <TabsTrigger v-if="canUseTransportLayers" value="transport">{{ t("connection.sshTunnel") }}</TabsTrigger>
                <TabsTrigger value="advanced">{{ t("connection.advancedTab") }}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="connection" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div v-if="!isJdbcConnection" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.connectionUrlOptional") }}</Label>
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
                  <Label class="text-right">{{ t("connection.name") }}</Label>
                  <Input v-model="form.name" class="col-span-3" :placeholder="t('connection.namePlaceholder')" />
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.type") }}</Label>
                  <button type="button" class="col-span-3 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 hover:bg-muted/40 cursor-pointer transition" @click="backToDatabasePicker()">
                    <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
                    <span class="min-w-0 flex-1 truncate text-sm text-left">{{ selectedProfile().label }}</span>
                    <Pencil class="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>

                <!-- OceanBase mode toggle -->
                <div v-if="selectedType === 'oceanbase'" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
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
                  <Label class="text-right text-xs">{{ t("connection.version") }}</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button size="sm" :variant="form.driver_profile === 'gbase8s' ? 'outline' : 'default'" @click="switchGbaseProfile('gbase8a')"> GBase 8a </Button>
                    <Button size="sm" :variant="form.driver_profile === 'gbase8s' ? 'default' : 'outline'" @click="switchGbaseProfile('gbase8s')"> GBase 8s </Button>
                  </div>
                </div>

                <div v-if="isCustomCompatibleProfile()" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.driverName") }}</Label>
                  <Input v-model="customDriverName" class="col-span-3" :placeholder="t('connection.driverNamePlaceholder')" />
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.color") }}</Label>
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
                  <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
                  <div class="col-span-3 flex gap-2">
                    <Button size="sm" :variant="h2ConnectionMode === 'file' ? 'default' : 'outline'" @click="switchH2ConnectionMode('file')">
                      {{ t("connection.h2FileMode") }}
                    </Button>
                    <Button size="sm" :variant="h2ConnectionMode === 'tcp' ? 'default' : 'outline'" @click="switchH2ConnectionMode('tcp')">
                      {{ t("connection.h2TcpMode") }}
                    </Button>
                  </div>
                </div>

                <!-- JDBC: optional external plugin -->
                <template v-if="form.db_type === 'jdbc'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.jdbcUrl") }}</Label>
                    <Input v-model="form.connection_string" class="col-span-3" :placeholder="t('connection.jdbcUrlPlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" placeholder="sa" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label class="text-right mt-2">{{ t("connection.jdbcDriverPaths") }}</Label>
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
                    <Label class="text-right">{{ t("connection.jdbcDriverClass") }}</Label>
                    <Input v-model="form.jdbc_driver_class" class="col-span-3" :placeholder="t('connection.jdbcDriverClassPlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <div class="col-span-3 space-y-2">
                      <p class="text-xs text-muted-foreground">
                        {{ t("connection.jdbcPluginHint") }}
                      </p>
                      <div class="flex flex-wrap gap-2">
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
                    <Label class="text-right">{{ t("connection.filePath") }}</Label>
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
                      </div>
                      <p v-if="supportsMemoryDatabasePath" class="text-xs text-muted-foreground">
                        {{ t("connection.memoryDatabasePathHint") }}
                      </p>
                    </div>
                  </div>
                  <div v-if="form.db_type === 'sqlite'" class="grid grid-cols-4 items-start gap-4">
                    <Label class="text-right mt-2">{{ t("connection.sqliteExtensions") }}</Label>
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
                  <template v-if="form.db_type === 'h2' || form.db_type === 'access'">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.user") }}{{ form.db_type === "access" ? "（可选）" : "" }}</Label>
                      <Input v-model="form.username" class="col-span-3" :placeholder="form.db_type === 'access' ? '' : 'sa'" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.password") }}{{ form.db_type === "access" ? "（可选）" : "" }}</Label>
                      <Input v-model="form.password" type="password" class="col-span-3" />
                    </div>
                  </template>
                </template>

                <!-- Redis: host, port, user, password, ssl -->
                <template v-else-if="form.db_type === 'redis'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
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
                    <Label class="text-right">{{ form.redis_connection_mode === "sentinel" ? t("connection.redisFirstSentinel") : form.redis_connection_mode === "cluster" ? t("connection.redisFirstClusterNode") : t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <template v-if="form.redis_connection_mode === 'sentinel'">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label class="text-right mt-2">{{ t("connection.redisSentinelNodes") }}</Label>
                      <textarea
                        v-model="form.redis_sentinel_nodes"
                        class="col-span-3 flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="sentinel-1:26379&#10;sentinel-2:26379"
                        spellcheck="false"
                      />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.redisSentinelMaster") }}</Label>
                      <Input v-model="form.redis_sentinel_master" class="col-span-3" placeholder="mymaster" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.redisSentinelUser") }}</Label>
                      <Input v-model="form.redis_sentinel_username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.redisSentinelPassword") }}</Label>
                      <Input v-model="form.redis_sentinel_password" type="password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.redisSentinelTls") }}</Label>
                      <label class="col-span-3 inline-flex items-center gap-2">
                        <input type="checkbox" v-model="form.redis_sentinel_tls" class="mr-0" />
                        <span class="text-xs text-muted-foreground">{{ t("connection.redisSentinelTlsHint") }}</span>
                      </label>
                    </div>
                  </template>
                  <template v-else-if="form.redis_connection_mode === 'cluster'">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label class="text-right mt-2">{{ t("connection.redisClusterNodes") }}</Label>
                      <textarea
                        v-model="form.redis_cluster_nodes"
                        class="col-span-3 flex min-h-[76px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="redis-1:6379&#10;redis-2:6379"
                        spellcheck="false"
                      />
                    </div>
                  </template>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" placeholder="default" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.redisKeySeparator") }}</Label>
                    <Input v-model="form.redis_key_separator" class="col-span-3 h-8 text-xs" placeholder=":" />
                  </div>
                </template>

                <!-- etcd: endpoints, user, password, TLS -->
                <template v-else-if="form.db_type === 'etcd'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label class="text-right mt-2">{{ t("connection.etcdEndpoints") }}</Label>
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
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" />
                  </div>
                </template>

                <!-- MongoDB: URL or form -->
                <template v-else-if="form.db_type === 'mongodb'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 flex gap-2">
                      <Button size="sm" :variant="mongoUseUrl ? 'outline' : 'default'" @click="mongoUseUrl = false">{{ t("connection.modeForm") }}</Button>
                      <Button size="sm" :variant="mongoUseUrl ? 'default' : 'outline'" @click="mongoUseUrl = true">URL</Button>
                    </div>
                  </div>
                  <template v-if="mongoUseUrl">
                    <div class="grid grid-cols-4 items-start gap-4">
                      <Label class="text-right mt-2">URL</Label>
                      <textarea
                        v-model="form.connection_string"
                        class="col-span-3 flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="mongodb+srv://user:pass@cluster.mongodb.net/mydb"
                      />
                    </div>
                  </template>
                  <template v-else>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.host") }}</Label>
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
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.user") }}</Label>
                      <Input v-model="form.username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.password") }}</Label>
                      <Input v-model="form.password" type="password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.defaultDatabase") }}</Label>
                      <Input v-model="form.database" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.authDatabase") }}</Label>
                      <Input v-model="mongoAuthDatabase" class="col-span-3" :placeholder="t('connection.authDatabasePlaceholder')" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.authMechanism") }}</Label>
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
                      <Label class="text-right">{{ t("connection.urlParams") }}</Label>
                      <Input v-model="form.url_params" class="col-span-3" placeholder="authSource=admin&authMechanism=SCRAM-SHA-1" />
                    </div>
                    <div class="grid grid-cols-4 items-start gap-4">
                      <span />
                      <p class="col-span-3 text-xs text-muted-foreground">
                        {{ t("connection.mongoLegacyHint") }}
                      </p>
                    </div>
                  </template>
                </template>

                <!-- Turso: simplified form (URL + Token) -->
                <template v-else-if="form.db_type === 'turso'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-3" placeholder="your-database.turso.io 或 libsql://your-database.turso.io" />
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 text-xs text-muted-foreground">支持 libsql:// 或 https:// 协议，也可以只填主机名（自动使用 HTTPS）</p>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">Auth Token</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..." />
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <span />
                    <p class="col-span-3 text-xs text-muted-foreground">使用 <code class="px-1 py-0.5 rounded bg-muted text-xs">turso db tokens create &lt;database-name&gt;</code> 创建 token</p>
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.urlParams") }}</Label>
                    <Input v-model="form.url_params" class="col-span-3" placeholder="authToken=xxx（可选，优先使用上面的 Token 字段）" />
                  </div>
                </template>

                <!-- MySQL / PostgreSQL: host, port, user, password, database -->
                <template v-else>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>

                  <div v-if="form.driver_profile === 'gbase8s'" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.gbaseServer") }}</Label>
                    <Input v-model="form.gbase_server" class="col-span-3" placeholder="gbase01" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" />
                  </div>

                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ databaseLabel }}</Label>
                    <Input v-model="form.database" class="col-span-3" :placeholder="databasePlaceholder" />
                  </div>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
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
                      {{ t("connection.driverInstallHintPrefix") }}<a class="underline cursor-pointer text-primary hover:text-primary/80" @click="emit('openDriverStore')">{{ t("toolbar.driverManager") }}</a
                      >{{ t("connection.driverInstallHintSuffix") }}
                    </p>
                  </div>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">SYSDBA</Label>
                    <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" v-model="form.sysdba" class="mr-0" :disabled="isOracleSysUser(form)" />
                      <span class="text-xs text-muted-foreground">as SYSDBA</span>
                    </label>
                  </div>

                  <div v-if="supportsGenericUrlParams" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.urlParams") }}</Label>
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
                                  ? 'INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8'
                                  : 'sslmode=disable'
                      "
                    />
                  </div>
                </template>
              </div>
            </TabsContent>

            <TabsContent v-if="supportsTlsToggle" value="tls" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div v-if="!supportsPostgresTlsOptions && !supportsMysqlTlsOptions" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">SSL/TLS</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.ssl" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.sslEnable") }}</span>
                  </label>
                </div>

                <div v-if="form.db_type === 'redis'" class="grid grid-cols-4 items-start gap-4">
                  <Label class="text-right text-xs">{{ t("connection.redisTlsInsecure") }}</Label>
                  <label class="col-span-3 flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" v-model="redisTlsInsecure" class="mr-0 mt-0.5" :disabled="!form.ssl" />
                    <span class="text-xs leading-5 text-muted-foreground">
                      {{ t("connection.redisTlsInsecureHint") }}
                    </span>
                  </label>
                </div>

                <template v-if="form.db_type === 'etcd'">
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label class="pt-2 text-right text-xs">
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
                    <Label class="pt-2 text-right text-xs">
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
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.mysqlTlsMode") }}</Label>
                    <Select v-model="mysqlTlsMode">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="preferred">{{ t("connection.mysqlTlsModePreferred") }}</SelectItem>
                        <SelectItem value="disabled">{{ t("connection.mysqlTlsModeDisabled") }}</SelectItem>
                        <SelectItem value="required">{{ t("connection.mysqlTlsModeRequired") }}</SelectItem>
                        <SelectItem value="verify_ca">{{ t("connection.mysqlTlsModeVerifyCa") }}</SelectItem>
                        <SelectItem value="verify_identity">{{ t("connection.mysqlTlsModeVerifyIdentity") }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label class="pt-2 text-right text-xs">
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
                    <Label class="pt-2 text-right text-xs">
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
                    <Label class="text-right text-xs">{{ t("connection.postgresSslMode") }}</Label>
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
                    <Label class="pt-2 text-right text-xs">
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
                    <Label class="pt-2 text-right text-xs">
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
                  <Label class="text-right text-xs">{{ t("connection.caCertPath") }}</Label>
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

            <TabsContent value="advanced" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.connectTimeout") }}</Label>
                  <Input v-model.number="form.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.queryTimeout") }}</Label>
                  <Input v-model.number="form.query_timeout_secs" type="number" min="0" max="300" step="1" class="col-span-3" />
                </div>
                <div v-show="form.db_type === 'mongodb'" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.idleTimeout") }}</Label>
                  <Input v-model.number="form.idle_timeout_secs" type="number" min="0" max="600" step="1" class="col-span-3" />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.readOnly") }}</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.read_only" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.readOnlyHint") }}</span>
                  </label>
                </div>
              </div>
            </TabsContent>

            <TabsContent v-if="canUseTransportLayers" value="transport" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div class="grid grid-cols-4 items-start gap-4">
                  <Label class="pt-2 text-right text-xs">{{ t("connection.sshHops") }}</Label>
                  <div class="col-span-3 grid gap-3">
                    <div class="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <template v-for="(segment, index) in transportPathSegments" :key="`${segment}-${index}`">
                        <span class="rounded border bg-muted/40 px-2 py-1">{{ segment }}</span>
                        <ChevronRight v-if="index < transportPathSegments.length - 1" class="h-3 w-3" />
                      </template>
                    </div>
                    <div class="grid gap-2">
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
                          {{ hop.name || hop.host || (hop.type === "proxy" ? `Proxy ${index + 1}` : t("connection.sshHopDefaultName", { index: index + 1 })) }}
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
                    <div class="flex items-center gap-2">
                      <Button type="button" variant="outline" size="sm" @click="addSshTunnel">
                        <Plus class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.sshHopAdd") }}
                      </Button>
                      <Button type="button" variant="outline" size="sm" @click="addProxyTunnel">
                        <Plus class="mr-1.5 h-3.5 w-3.5" />
                        {{ t("connection.proxy") }}
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
                    <Label class="text-right text-xs">{{ t("connection.sshHopName") }}</Label>
                    <Input v-model="selectedTransportLayer.name" class="col-span-3" :placeholder="t('connection.sshHopNamePlaceholder')" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">Type</Label>
                    <Select :model-value="selectedTransportLayer.type" @update:model-value="(value: any) => changeSelectedTransportLayerType(value)">
                      <SelectTrigger class="col-span-3 h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ssh">SSH</SelectItem>
                        <SelectItem value="proxy">Proxy</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <template v-if="selectedSshLayer">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshHost") }}</Label>
                      <Input v-model="selectedSshLayer.host" class="col-span-2" placeholder="ssh.example.com" :disabled="selectedSshLayer.enabled === false" />
                      <Input v-model.number="selectedSshLayer.port" type="number" min="1" max="65535" class="col-span-1" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshUser") }}</Label>
                      <Input v-model="selectedSshLayer.user" class="col-span-3" placeholder="root" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshPassword") }}</Label>
                      <Input v-model="selectedSshLayer.password" type="password" class="col-span-3" :placeholder="t('connection.sshPasswordPlaceholder')" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshKeyPath") }}</Label>
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
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshKeyPassphrase") }}</Label>
                      <Input v-model="selectedSshLayer.key_passphrase" type="password" class="col-span-3" :placeholder="t('connection.sshKeyPassphrasePlaceholder')" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <span />
                      <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" v-model="selectedSshLayer.use_ssh_agent" class="mr-0" :disabled="selectedSshLayer.enabled === false" />
                        <span class="text-xs text-muted-foreground">{{ t("connection.sshUseAgent") }}</span>
                      </label>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <span />
                      <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" v-model="selectedSshLayer.expose_lan" class="mr-0" :disabled="selectedSshLayer.enabled === false" />
                        <span class="text-xs text-muted-foreground">{{ t("connection.sshExposeLan") }}</span>
                      </label>
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.sshConnectTimeout") }}</Label>
                      <Input v-model.number="selectedSshLayer.connect_timeout_secs" type="number" min="1" max="300" step="1" class="col-span-3" :disabled="selectedSshLayer.enabled === false" />
                    </div>
                  </template>
                  <template v-else-if="selectedProxyLayer">
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.proxyType") }}</Label>
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
                      <Label class="text-right text-xs">{{ t("connection.proxyHost") }}</Label>
                      <Input v-model="selectedProxyLayer.host" class="col-span-2" placeholder="127.0.0.1" :disabled="selectedProxyLayer.enabled === false" />
                      <Input v-model.number="selectedProxyLayer.port" type="number" class="col-span-1" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.proxyUsername") }}</Label>
                      <Input v-model="selectedProxyLayer.username" class="col-span-3" :placeholder="t('connection.proxyUsernamePlaceholder')" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right text-xs">{{ t("connection.proxyPassword") }}</Label>
                      <Input v-model="selectedProxyLayer.password" type="password" class="col-span-3" :placeholder="t('connection.proxyPasswordPlaceholder')" :disabled="selectedProxyLayer.enabled === false" />
                    </div>
                  </template>
                </template>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter class="flex min-w-0 items-center gap-2 sm:flex-nowrap">
          <div class="mr-auto flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden">
            <Button v-if="!editingId" variant="outline" class="shrink-0" :disabled="isSaving" @click="backToDatabasePicker">
              <ArrowLeft class="h-4 w-4" />
              {{ t("connection.back") }}
            </Button>
            <template v-if="testResult">
              <span class="block min-w-0 flex-1 basis-0 truncate text-xs" :class="testResult.ok ? 'text-green-600' : 'text-red-600'" :title="testResultMessage" role="status" aria-live="polite">
                {{ testResultMessage }}
              </span>
              <Button variant="ghost" size="icon-xs" class="h-5 w-5 shrink-0" :title="t('connection.copyTestResult')" :aria-label="t('connection.copyTestResult')" @click="copyTestResult">
                <Copy class="h-3 w-3" />
              </Button>
            </template>
          </div>
          <Button v-if="canChooseVisibleDatabases" variant="outline" class="shrink-0" :disabled="isTesting || isSaving || isLoadingVisibleDatabases || !hasRequiredConnectionTarget" @click="openVisibleDatabasesPicker">
            <Loader2 v-if="isLoadingVisibleDatabases" class="mr-1.5 h-4 w-4 animate-spin" />
            <ListFilter v-else class="mr-1.5 h-4 w-4" />
            {{ hasVisibleDatabaseFilter ? visibleDatabaseSummary : t("contextMenu.selectVisibleDatabases") }}
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

  <Dialog v-model:open="showVisibleDatabasesDialog">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("visibleDatabases.title") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">
          {{ t("visibleDatabases.description", { connection: form.name || selectedProfile().label }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="visibleDatabaseSearchText" :placeholder="t('visibleDatabases.searchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {{
            t("visibleDatabases.selectedCount", {
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
        {{ t("visibleDatabases.emptySelection") }}
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
          {{ t("visibleDatabases.loadFailed", { message: visibleDatabaseError }) }}
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
          {{ t("visibleDatabases.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
