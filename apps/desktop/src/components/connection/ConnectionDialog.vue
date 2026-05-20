<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionConfig, DatabaseType, JdbcDriverInfo } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { applyParsedConnectionUrl, parseConnectionUrl } from "@/lib/connectionUrl";
import type { ConnectionDeepLinkDraft } from "@/lib/connectionDeepLink";
import { connectionUrlPlaceholder as getUrlPlaceholder } from "@/lib/connectionPresentation";
import { mongodbAuthFailureHint, mongoUrlParam, setMongoUrlParam } from "@/lib/mongoConnectionOptions";
import { showAgentDriverInstallHint, type AgentDriverInstallState } from "@/lib/agentDriverInstallHint";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  Grid3X3,
  Link2,
  List,
  Search,
} from "lucide-vue-next";

type DbOption = { value: string; label: string };
type DbCategory = { key: string; title: string; options: DbOption[] };
type DialogStep = "select" | "config";
type DbPickerView = "icon" | "list";
type ConfigTab = "connection" | "ssh" | "proxy";

const { t } = useI18n();
const { toast } = useToast();
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
let testRunId = 0;

const defaultForm = (): Omit<ConnectionConfig, "id"> => ({
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
  ssh_enabled: false,
  ssh_host: "",
  ssh_port: 22,
  ssh_user: "",
  ssh_password: "",
  ssh_key_path: "",
  ssh_key_passphrase: "",
  ssh_expose_lan: false,
  ssh_connect_timeout_secs: 5,
  proxy_enabled: false,
  proxy_type: "socks5",
  proxy_host: "",
  proxy_port: 1080,
  proxy_username: "",
  proxy_password: "",
  ssl: false,
  oracle_connection_type: "service_name",
  connection_string: undefined,
  jdbc_driver_class: undefined,
  jdbc_driver_paths: [],
});

const form = ref(defaultForm());
const selectedType = ref("mysql");
const customDriverName = ref("");
const mongoUseUrl = ref(false);
const jdbcDriverPathsInput = ref("");
const jdbcDrivers = ref<JdbcDriverInfo[]>([]);
const agentDrivers = ref<AgentDriverInstallState[]>([]);
const selectedJdbcDriverPath = ref("");
const connectionUrlInput = ref("");
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

const driverProfiles: Record<
  string,
  {
    type: DatabaseType;
    port: number;
    user: string;
    label: string;
    icon: string;
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
  "oracle-10g": { type: "oracle", port: 1521, user: "system", label: "Oracle 10g", icon: "oracle" },
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
  tdsql: { type: "mysql", port: 3306, user: "root", label: "TDSQL", icon: "tdsql" },
  polardb: { type: "mysql", port: 3306, user: "root", label: "PolarDB", icon: "polardb" },
  greatsql: { type: "mysql", port: 3306, user: "root", label: "GreatSQL", icon: "greatsql" },
  databricks: { type: "databricks", port: 443, user: "token", label: "Databricks SQL", icon: "databricks" },
  saphana: { type: "saphana", port: 30015, user: "SYSTEM", label: "SAP HANA", icon: "saphana" },
  teradata: { type: "teradata", port: 1025, user: "", label: "Teradata", icon: "teradata" },
  vertica: { type: "vertica", port: 5433, user: "dbadmin", label: "Vertica", icon: "vertica" },
  firebird: { type: "firebird", port: 3050, user: "SYSDBA", label: "Firebird", icon: "firebird" },
  exasol: { type: "exasol", port: 8563, user: "sys", label: "Exasol", icon: "exasol" },
  gbase: { type: "gbase", port: 5258, user: "gbasedbt", label: "GBase", icon: "gbase" },
  opengauss: {
    type: "opengauss",
    port: 5432,
    user: "gaussdb",
    label: "openGauss",
    icon: "opengauss",
  },
  gaussdb: { type: "gaussdb", port: 5432, user: "gaussdb", label: "GaussDB", icon: "gaussdb" },
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
  bigquery: { type: "bigquery", port: 443, user: "", label: "BigQuery", icon: "bigquery" },
  kylin: { type: "kylin", port: 7070, user: "ADMIN", label: "Apache Kylin", icon: "kylin" },
  sundb: { type: "sundb", port: 22000, user: "root", label: "SunDB", icon: "sundb" },
  jdbc: { type: "jdbc", port: 0, user: "", label: "JDBC", icon: "jdbc" },
  tdengine: { type: "tdengine", port: 6041, user: "root", label: "TDengine", icon: "tdengine" },
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
  if (config.driver_profile && driverProfiles[config.driver_profile]) return config.driver_profile;
  if (config.db_type === "dameng") return "dm";
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
  form.value.driver_label = isCustomCompatibleProfile()
    ? customDriverName.value.trim() || profile.label
    : profile.label;

  if (!preserveConnectionFields) {
    form.value.port = profile.port;
    form.value.username = profile.user;
    form.value.url_params = profile.urlParams || "";
    if (profile.type === "sqlite" || profile.type === "duckdb" || profile.type === "access") {
      form.value.host = "";
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

watch(
  () => props.editConfig,
  (config) => {
    if (config) {
      const profile = profileForConfig(config);
      editingId.value = config.id;
      const profileConfig = driverProfiles[profile];
      form.value = {
        name: config.name,
        db_type: profileConfig?.type || config.db_type,
        driver_profile: profile,
        driver_label: config.driver_label || driverProfiles[profile]?.label || config.db_type,
        url_params: config.url_params || "",
        host: config.host,
        port: profile === "tdengine" && (config.port === 0 || config.port === 6030) ? 6041 : config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        color: config.color || "",
        ssh_enabled: config.ssh_enabled || false,
        ssh_host: config.ssh_host || "",
        ssh_port: config.ssh_port || 22,
        ssh_user: config.ssh_user || "",
        ssh_password: config.ssh_password || "",
        ssh_key_path: config.ssh_key_path || "",
        ssh_key_passphrase: config.ssh_key_passphrase || "",
        ssh_expose_lan: config.ssh_expose_lan || false,
        ssh_connect_timeout_secs: config.ssh_connect_timeout_secs || 5,
        proxy_enabled: config.proxy_enabled || false,
        proxy_type: config.proxy_type || "socks5",
        proxy_host: config.proxy_host || "",
        proxy_port: config.proxy_port || 1080,
        proxy_username: config.proxy_username || "",
        proxy_password: config.proxy_password || "",
        ssl: config.ssl || false,
        oracle_connection_type: config.oracle_connection_type || "service_name",
        connection_string: config.connection_string,
        jdbc_driver_class: config.jdbc_driver_class,
        jdbc_driver_paths: config.jdbc_driver_paths || [],
      };
      selectedType.value = profile;
      mongoUseUrl.value = !!config.connection_string;
      jdbcDriverPathsInput.value = (config.jdbc_driver_paths || []).join("\n");
      customDriverName.value = isCustomCompatibleProfile() ? config.driver_label || "" : "";
      dialogStep.value = "config";
      configTab.value = "connection";
    } else {
      editingId.value = null;
      form.value = defaultForm();
      selectedType.value = "mysql";
      customDriverName.value = "";
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

const databaseLabel = computed(() =>
  form.value.db_type === "oracle" ? t("connection.serviceName") : t("connection.database"),
);

const databasePlaceholder = computed(() => {
  const fallback = defaultDatabaseForProfile();
  if (!fallback) return t("connection.databasePlaceholder");
  return t("connection.databasePlaceholderWithDefault", { database: fallback });
});

function defaultDatabaseForProfile() {
  if (form.value.db_type === "redshift") return "dev";
  if (form.value.db_type === "gaussdb") return "postgres";
  if (selectedType.value === "cockroachdb") return "defaultdb";
  if (form.value.db_type === "highgo") return "highgo";
  if (form.value.db_type === "yashandb") return "yasdb";
  if (form.value.db_type === "postgres" || form.value.db_type === "kingbase" || form.value.db_type === "vastbase")
    return "postgres";
  if (form.value.db_type === "sqlserver") return "master";
  if (form.value.db_type === "oracle") return "ORCL";
  return "";
}

function onDbTypeChange(val: string) {
  customDriverName.value = "";
  applyProfile(val, !!editingId.value);
  resetTestState();
}

const iconTypeMap: Record<string, string> = {
  mysql: "mysql",
  postgres: "postgres",
  sqlite: "sqlite",
  access: "access",
  redis: "redis",
  mongodb: "mongodb",
  duckdb: "duckdb",
  clickhouse: "clickhouse",
  sqlserver: "sqlserver",
  oracle: "oracle",
  "oracle-10g": "oracle",
  elasticsearch: "elasticsearch",
  mariadb: "mariadb",
  tidb: "tidb",
  oceanbase: "oceanbase",
  "oceanbase-oracle": "oceanbase",
  goldendb: "goldendb",
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
  kingbase: "kingbase",
  highgo: "highgo",
  yashandb: "yashandb",
  vastbase: "vastbase",
  doris: "doris",
  selectdb: "selectdb",
  starrocks: "starrocks",
  redshift: "redshift",
  cockroachdb: "cockroachdb",
  tdengine: "tdengine",
  dm: "dm",
  h2: "h2",
  snowflake: "snowflake",
  trino: "trino",
  hive: "hive",
  db2: "db2",
  informix: "informix",
  neo4j: "neo4j",
  cassandra: "cassandra",
  bigquery: "bigquery",
  kylin: "kylin",
  sundb: "sundb",
  jdbc: "jdbc",
  custom_mysql: "mysql",
  custom_postgres: "postgres",
};

const dbOptions = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "access", label: "Microsoft Access" },
  { value: "redis", label: "Redis" },
  { value: "mongodb", label: "MongoDB" },
  { value: "duckdb", label: "DuckDB" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "oracle", label: "Oracle" },
  { value: "elasticsearch", label: "Elasticsearch" },
  { value: "mariadb", label: "MariaDB" },
  { value: "dm", label: "DM (Dameng)" },
  { value: "gaussdb", label: "GaussDB" },
  { value: "tidb", label: "TiDB" },
  { value: "oceanbase", label: "OceanBase" },
  { value: "oceanbase-oracle", label: "OceanBase Oracle Mode" },
  { value: "goldendb", label: "GoldenDB" },
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
  { value: "opengauss", label: "openGauss" },
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
  { value: "jdbc", label: "JDBC" },
  { value: "custom_mysql", label: "Custom (MySQL)" },
  { value: "custom_postgres", label: "Custom (PostgreSQL)" },
];

const dbCategories = computed<DbCategory[]>(() => [{ key: "all", title: "", options: dbOptions }]);

const filteredDbCategories = computed<DbCategory[]>(() => {
  const keyword = dbSearchQuery.value.trim().toLowerCase();
  if (!keyword) return dbCategories.value;

  return dbCategories.value
    .map((category) => ({
      ...category,
      options: category.options.filter((option) => {
        const profile = driverProfiles[option.value];
        return [option.label, option.value, profile?.label, profile?.type, category.title].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(keyword),
        );
      }),
    }))
    .filter((category) => category.options.length > 0);
});

const hasDbPickerResults = computed(() => filteredDbCategories.value.some((category) => category.options.length > 0));
const selectedDbIcon = computed(() => iconTypeMap[selectedType.value] || selectedProfile().icon || selectedType.value);
const isJdbcConnection = computed(() => form.value.db_type === "jdbc");

const connectionUrlPlaceholder = computed(() => getUrlPlaceholder(form.value.db_type));
const filePathPlaceholder = computed(() => {
  if (form.value.db_type === "duckdb") return "/path/to/database.duckdb or :memory:";
  if (form.value.db_type === "access") return "/path/to/database.accdb";
  return "/path/to/database.db or :memory:";
});
const supportsMemoryDatabasePath = computed(() => form.value.db_type === "sqlite" || form.value.db_type === "duckdb");
const canUseSsh = computed(() => form.value.db_type !== "sqlite" && form.value.db_type !== "access");
const canUseProxy = computed(
  () => form.value.db_type !== "sqlite" && form.value.db_type !== "duckdb" && form.value.db_type !== "access",
);
const shouldShowAgentDriverInstallHint = computed(() =>
  showAgentDriverInstallHint(form.value.db_type, agentDrivers.value),
);
const testResultMessage = computed(() => {
  if (!testResult.value) return "";
  return testResult.value.ok ? t("connection.testSuccess") : testResult.value.message;
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

function generateConnectionName(): string {
  const label = selectedProfile().label;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${label}_${rand}`;
}

function connectionConfigForSubmit(id: string): ConnectionConfig {
  const config: ConnectionConfig = { ...form.value, id };
  if (!config.name?.trim()) {
    config.name = generateConnectionName();
  }
  const sshTimeout = Number(config.ssh_connect_timeout_secs);
  config.ssh_connect_timeout_secs = Number.isFinite(sshTimeout) && sshTimeout > 0 ? sshTimeout : 5;
  const proxyPort = Number(config.proxy_port);
  config.proxy_port = Number.isFinite(proxyPort) && proxyPort > 0 ? proxyPort : 1080;
  if (!config.one_time) config.one_time = undefined;
  if (config.db_type === "mongodb" && !mongoUseUrl.value) {
    config.connection_string = undefined;
  }
  if (config.db_type !== "oracle") {
    config.oracle_connection_type = undefined;
  } else {
    config.oracle_connection_type = config.oracle_connection_type || "service_name";
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
  return config;
}

function resetTestState() {
  testRunId += 1;
  isTesting.value = false;
  testResult.value = null;
}

function applyConnectionUrl() {
  try {
    const parsed = parseConnectionUrl(connectionUrlInput.value, selectedType.value);
    form.value = applyParsedConnectionUrl(form.value, parsed);
    selectedType.value = parsed.driverProfile;
    customDriverName.value = isCustomCompatibleProfile() ? parsed.driverLabel : "";
    mongoUseUrl.value = !!parsed.useMongoUrl;
    if (!form.value.name.trim()) {
      form.value.name = parsed.database || parsed.host || parsed.driverLabel;
    }
    resetTestState();
    toast(t("connection.parseConnectionUrlApplied"), 2000);
  } catch (e: any) {
    toast(t("connection.parseConnectionUrlFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyTestResult() {
  if (!testResultMessage.value) return;
  await navigator.clipboard.writeText(testResultMessage.value);
  toast(t("grid.copied"));
}

function resetForm() {
  editingId.value = null;
  form.value = defaultForm();
  selectedType.value = "mysql";
  customDriverName.value = "";
  mongoUseUrl.value = false;
  jdbcDriverPathsInput.value = "";
  selectedJdbcDriverPath.value = "";
  connectionUrlInput.value = "";
  dialogStep.value = "select";
  dbPickerView.value = "icon";
  dbSearchQuery.value = "";
  configTab.value = "connection";
  resetTestState();
}

const submittedOneTimePrefillKey = ref<string | null>(null);

function oneTimePrefillKey(draft: ConnectionDeepLinkDraft) {
  return JSON.stringify([
    draft.name,
    draft.dbType,
    draft.driverProfile,
    draft.driverLabel,
    draft.host,
    draft.port,
    draft.username,
    draft.password,
    draft.database,
    draft.urlParams,
    draft.ssl,
    draft.connectionString,
    draft.oracleConnectionType,
    draft.useMongoUrl,
  ]);
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

watch(canUseSsh, (value) => {
  if (!value && configTab.value === "ssh") {
    configTab.value = "connection";
  }
});

watch(canUseProxy, (value) => {
  if (!value && configTab.value === "proxy") {
    configTab.value = "connection";
  }
});

async function save() {
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

async function browseSshKeyPath() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "Select SSH Private Key",
      multiple: false,
    });
    if (selected && typeof selected === "string") {
      form.value.ssh_key_path = selected;
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
  const merged = Array.from(
    new Set([...existing, ...paths.filter((path): path is string => typeof path === "string")]),
  );
  jdbcDriverPathsInput.value = merged.join("\n");
}

async function loadJdbcDrivers() {
  if (!isDesktop) return;
  try {
    jdbcDrivers.value = await api.listJdbcDrivers();
  } catch {
    jdbcDrivers.value = [];
  }
}

async function loadAgentDrivers() {
  try {
    agentDrivers.value = await api.listInstalledAgentsLocal();
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

function addJdbcDriverPath(path: string) {
  const existing = jdbcDriverPathsInput.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  jdbcDriverPathsInput.value = Array.from(new Set([...existing, path])).join("\n");
}

function onJdbcDriverSelect(path: any) {
  if (typeof path !== "string" || !path) return;
  selectedJdbcDriverPath.value = path;
  addJdbcDriverPath(path);
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
    <DialogContent :class="dialogStep === 'select' ? 'sm:max-w-[760px]' : 'sm:max-w-[560px]'">
      <DialogHeader>
        <DialogTitle>{{ editingId ? t("connection.editTitle") : t("connection.title") }}</DialogTitle>
      </DialogHeader>

      <template v-if="dialogStep === 'select'">
        <div class="space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
            <div class="flex items-center gap-2">
              <div class="flex shrink-0 rounded-lg border bg-muted/40 p-0.5">
                <Button
                  type="button"
                  size="icon-sm"
                  :variant="dbPickerView === 'icon' ? 'secondary' : 'ghost'"
                  :title="t('connection.iconView')"
                  :aria-label="t('connection.iconView')"
                  @click="dbPickerView = 'icon'"
                >
                  <Grid3X3 class="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  :variant="dbPickerView === 'list' ? 'secondary' : 'ghost'"
                  :title="t('connection.listView')"
                  :aria-label="t('connection.listView')"
                  @click="dbPickerView = 'list'"
                >
                  <List class="h-3.5 w-3.5" />
                </Button>
              </div>
              <div class="relative w-full sm:w-64">
                <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  v-model="dbSearchQuery"
                  class="h-9 pl-8"
                  :placeholder="t('connection.searchDatabasePlaceholder')"
                />
              </div>
            </div>
          </div>

          <div class="max-h-[58vh] space-y-5 overflow-y-auto pr-2">
            <section v-for="category in filteredDbCategories" :key="category.key" class="space-y-2">
              <div class="flex items-center">
                <h3 class="text-sm font-medium">{{ category.title }}</h3>
              </div>

              <div v-if="dbPickerView === 'icon'" class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                <button
                  v-for="opt in category.options"
                  :key="opt.value"
                  type="button"
                  class="group flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border bg-background/70 p-3 text-center transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="
                    selectedType === opt.value
                      ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/30'
                      : 'border-border'
                  "
                  :aria-pressed="selectedType === opt.value"
                  @click="onDbTypeChange(opt.value)"
                  @dblclick="goToConnectionStep(opt.value)"
                >
                  <span
                    class="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 transition group-hover:bg-background"
                  >
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
                  :class="
                    selectedType === opt.value ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border'
                  "
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

            <div
              v-if="!hasDbPickerResults"
              class="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground"
            >
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
            <div v-if="canUseSsh || canUseProxy" class="flex items-center justify-between border-b pb-2">
              <TabsList>
                <TabsTrigger value="connection">{{ t("connection.basicTab") }}</TabsTrigger>
                <TabsTrigger v-if="canUseSsh" value="ssh">{{ t("connection.sshTunnel") }}</TabsTrigger>
                <TabsTrigger v-if="canUseProxy" value="proxy">{{ t("connection.proxy") }}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="connection" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div v-if="!isJdbcConnection" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.connectionUrlOptional") }}</Label>
                  <div class="col-span-3 flex items-center gap-1">
                    <Input
                      v-model="connectionUrlInput"
                      class="flex-1"
                      :placeholder="connectionUrlPlaceholder"
                      @keydown.enter.prevent="applyConnectionUrl"
                    />
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <Button
                          variant="outline"
                          size="icon"
                          class="h-9 w-9 shrink-0"
                          :disabled="!connectionUrlInput.trim()"
                          :aria-label="t('connection.parseConnectionUrl')"
                          @click="applyConnectionUrl"
                        >
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
                  <button
                    type="button"
                    class="col-span-3 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 hover:bg-muted/40 cursor-pointer transition"
                    @click="backToDatabasePicker()"
                  >
                    <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
                    <span class="min-w-0 flex-1 truncate text-sm text-left">{{ selectedProfile().label }}</span>
                    <Pencil class="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>

                <div v-if="isCustomCompatibleProfile()" class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.driverName") }}</Label>
                  <Input
                    v-model="customDriverName"
                    class="col-span-3"
                    :placeholder="t('connection.driverNamePlaceholder')"
                  />
                </div>

                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right">{{ t("connection.color") }}</Label>
                  <div class="col-span-3 flex items-center gap-1.5">
                    <button
                      v-for="color in colorOptions"
                      :key="color.value || 'none'"
                      type="button"
                      class="h-6 w-6 rounded-full border ring-offset-background transition hover:scale-105"
                      :class="[
                        color.class,
                        form.color === color.value ? 'ring-2 ring-ring ring-offset-2' : 'border-border',
                      ]"
                      :title="t(color.labelKey)"
                      @click="form.color = color.value"
                    />
                  </div>
                </div>

                <!-- JDBC: optional external plugin -->
                <template v-if="form.db_type === 'jdbc'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.jdbcUrl") }}</Label>
                    <Input
                      v-model="form.connection_string"
                      class="col-span-3"
                      :placeholder="t('connection.jdbcUrlPlaceholder')"
                    />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" placeholder="sa" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input v-model="form.password" type="password" class="col-span-3" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.jdbcDriverClass") }}</Label>
                    <Input
                      v-model="form.jdbc_driver_class"
                      class="col-span-3"
                      :placeholder="t('connection.jdbcDriverClassPlaceholder')"
                    />
                  </div>
                  <div class="grid grid-cols-4 items-start gap-4">
                    <Label class="text-right mt-2">{{ t("connection.jdbcDriverPaths") }}</Label>
                    <div class="col-span-3 space-y-2">
                      <Select
                        v-if="jdbcDrivers.length > 0"
                        :model-value="selectedJdbcDriverPath"
                        @update:model-value="onJdbcDriverSelect"
                      >
                        <SelectTrigger>
                          <SelectValue :placeholder="t('connection.jdbcDriverSelectPlaceholder')" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="driver in jdbcDrivers" :key="driver.path" :value="driver.path">
                            {{ driver.name }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <div class="flex items-start gap-1">
                        <textarea
                          v-model="jdbcDriverPathsInput"
                          class="flex min-h-12 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          :placeholder="t('connection.jdbcDriverPathsPlaceholder')"
                        />
                        <Tooltip v-if="isDesktop">
                          <TooltipTrigger as-child>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              class="h-9 w-9 shrink-0"
                              @click="browseJdbcDriverPaths"
                            >
                              <FolderOpen class="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{{ t("connection.jdbcDriverBrowse") }}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
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
                <template
                  v-else-if="form.db_type === 'sqlite' || form.db_type === 'duckdb' || form.db_type === 'access'"
                >
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
                            <Button
                              variant="outline"
                              size="icon"
                              class="h-9 w-9 shrink-0"
                              @click="createDuckDbFilePath"
                            >
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
                </template>

                <!-- Redis: host, port, user, password, ssl -->
                <template v-else-if="form.db_type === 'redis'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.user") }}</Label>
                    <Input v-model="form.username" class="col-span-3" placeholder="default" />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.password") }}</Label>
                    <Input
                      v-model="form.password"
                      type="password"
                      class="col-span-3"
                      :placeholder="t('connection.databasePlaceholder')"
                    />
                  </div>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">SSL/TLS</Label>
                    <div class="col-span-3">
                      <input type="checkbox" v-model="form.ssl" class="mr-2" />
                      <span class="text-xs text-muted-foreground">{{ t("connection.sshEnable") }}</span>
                    </div>
                  </div>
                </template>

                <!-- MongoDB: URL or form -->
                <template v-else-if="form.db_type === 'mongodb'">
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">{{ t("connection.mode") }}</Label>
                    <div class="col-span-3 flex gap-2">
                      <Button size="sm" :variant="mongoUseUrl ? 'outline' : 'default'" @click="mongoUseUrl = false">{{
                        t("connection.modeForm")
                      }}</Button>
                      <Button size="sm" :variant="mongoUseUrl ? 'default' : 'outline'" @click="mongoUseUrl = true"
                        >URL</Button
                      >
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
                      <Label class="text-right">{{ t("connection.user") }}</Label>
                      <Input v-model="form.username" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.password") }}</Label>
                      <Input v-model="form.password" type="password" class="col-span-3" />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.defaultDatabase") }}</Label>
                      <Input
                        v-model="form.database"
                        class="col-span-3"
                        :placeholder="t('connection.databasePlaceholder')"
                      />
                    </div>
                    <div class="grid grid-cols-4 items-center gap-4">
                      <Label class="text-right">{{ t("connection.authDatabase") }}</Label>
                      <Input
                        v-model="mongoAuthDatabase"
                        class="col-span-3"
                        :placeholder="t('connection.authDatabasePlaceholder')"
                      />
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
                      <Input
                        v-model="form.url_params"
                        class="col-span-3"
                        placeholder="authSource=admin&authMechanism=SCRAM-SHA-1"
                      />
                    </div>
                    <div class="grid grid-cols-4 items-start gap-4">
                      <span />
                      <p class="col-span-3 text-xs text-muted-foreground">
                        {{ t("connection.mongoLegacyHint") }}
                      </p>
                    </div>
                  </template>
                </template>

                <!-- MySQL / PostgreSQL: host, port, user, password, database -->
                <template v-else>
                  <div class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right">{{ t("connection.host") }}</Label>
                    <Input v-model="form.host" class="col-span-2" />
                    <Input v-model.number="form.port" type="number" class="col-span-1" />
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
                    <Label class="text-right text-xs">连接方式</Label>
                    <div
                      class="col-span-3 grid h-8 grid-cols-2 overflow-hidden rounded-md border border-input bg-muted/30 p-0.5"
                    >
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="
                          form.oracle_connection_type !== 'sid'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        "
                        :aria-pressed="form.oracle_connection_type !== 'sid'"
                        @click="form.oracle_connection_type = 'service_name'"
                      >
                        服务名
                      </button>
                      <button
                        type="button"
                        class="h-7 rounded-sm px-3 text-sm transition-colors"
                        :class="
                          form.oracle_connection_type === 'sid'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        "
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
                      需要在顶部导航栏「<a
                        class="underline cursor-pointer text-primary hover:text-primary/80"
                        @click="emit('openDriverStore')"
                        >驱动管理</a
                      >」中安装对应的驱动才能连接。
                    </p>
                  </div>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">版本</Label>
                    <Select
                      :model-value="selectedType === 'oracle-10g' ? 'oracle-10g' : 'oracle'"
                      @update:model-value="(val) => applyProfile(String(val), true)"
                    >
                      <SelectTrigger class="col-span-3 h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="oracle">Oracle 11g+</SelectItem>
                        <SelectItem value="oracle-10g">Oracle 10g</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div v-if="form.db_type === 'oracle'" class="grid grid-cols-4 items-center gap-4">
                    <Label class="text-right text-xs">SYSDBA</Label>
                    <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" v-model="form.sysdba" class="mr-0" />
                      <span class="text-xs text-muted-foreground">as SYSDBA</span>
                    </label>
                  </div>

                  <div
                    v-if="
                      form.db_type === 'mysql' ||
                      form.db_type === 'postgres' ||
                      form.db_type === 'redshift' ||
                      form.db_type === 'informix' ||
                      form.db_type === 'kingbase' ||
                      form.db_type === 'highgo' ||
                      form.db_type === 'yashandb' ||
                      form.db_type === 'vastbase' ||
                      form.db_type === 'goldendb'
                    "
                    class="grid grid-cols-4 items-center gap-4"
                  >
                    <Label class="text-right">{{ t("connection.urlParams") }}</Label>
                    <Input
                      v-model="form.url_params"
                      class="col-span-3"
                      :placeholder="
                        form.db_type === 'mysql'
                          ? 'charset=utf8mb4'
                          : form.db_type === 'informix'
                            ? 'INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8'
                            : 'sslmode=disable'
                      "
                    />
                  </div>
                </template>
              </div>
            </TabsContent>

            <TabsContent v-if="canUseSsh" value="ssh" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshTunnel") }}</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.ssh_enabled" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.sshEnable") }}</span>
                  </label>
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshHost") }}</Label>
                  <Input
                    v-model="form.ssh_host"
                    class="col-span-2"
                    placeholder="ssh.example.com"
                    :disabled="!form.ssh_enabled"
                  />
                  <Input
                    v-model.number="form.ssh_port"
                    type="number"
                    class="col-span-1"
                    :disabled="!form.ssh_enabled"
                  />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshUser") }}</Label>
                  <Input v-model="form.ssh_user" class="col-span-3" placeholder="root" :disabled="!form.ssh_enabled" />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshPassword") }}</Label>
                  <Input
                    v-model="form.ssh_password"
                    type="password"
                    class="col-span-3"
                    :placeholder="t('connection.sshPasswordPlaceholder')"
                    :disabled="!form.ssh_enabled"
                  />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshKeyPath") }}</Label>
                  <div class="col-span-3 flex items-center gap-1">
                    <Input
                      v-model="form.ssh_key_path"
                      class="flex-1"
                      placeholder="~/.ssh/id_rsa"
                      :disabled="!form.ssh_enabled"
                    />
                    <Tooltip v-if="isDesktop">
                      <TooltipTrigger as-child>
                        <Button
                          variant="outline"
                          size="icon"
                          class="h-9 w-9 shrink-0"
                          :disabled="!form.ssh_enabled"
                          @click="browseSshKeyPath"
                        >
                          <FolderOpen class="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{{ t("connection.sshKeyPathBrowse") }}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshKeyPassphrase") }}</Label>
                  <Input
                    v-model="form.ssh_key_passphrase"
                    type="password"
                    class="col-span-3"
                    :placeholder="t('connection.sshKeyPassphrasePlaceholder')"
                    :disabled="!form.ssh_enabled"
                  />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <span />
                  <label
                    class="col-span-3 flex items-center gap-2"
                    :class="form.ssh_enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'"
                  >
                    <input type="checkbox" v-model="form.ssh_expose_lan" class="mr-0" :disabled="!form.ssh_enabled" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.sshExposeLan") }}</span>
                  </label>
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.sshConnectTimeout") }}</Label>
                  <Input
                    v-model.number="form.ssh_connect_timeout_secs"
                    type="number"
                    min="5"
                    max="300"
                    step="1"
                    class="col-span-3"
                    :disabled="!form.ssh_enabled"
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent v-if="canUseProxy" value="proxy" class="m-0">
              <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.proxy") }}</Label>
                  <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="form.proxy_enabled" class="mr-0" />
                    <span class="text-xs text-muted-foreground">{{ t("connection.proxyEnable") }}</span>
                  </label>
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.proxyType") }}</Label>
                  <Select
                    :model-value="form.proxy_type || 'socks5'"
                    :disabled="!form.proxy_enabled"
                    @update:model-value="(value: any) => (form.proxy_type = value)"
                  >
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
                  <Input
                    v-model="form.proxy_host"
                    class="col-span-2"
                    placeholder="127.0.0.1"
                    :disabled="!form.proxy_enabled"
                  />
                  <Input
                    v-model.number="form.proxy_port"
                    type="number"
                    class="col-span-1"
                    :disabled="!form.proxy_enabled"
                  />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.proxyUsername") }}</Label>
                  <Input
                    v-model="form.proxy_username"
                    class="col-span-3"
                    :placeholder="t('connection.proxyUsernamePlaceholder')"
                    :disabled="!form.proxy_enabled"
                  />
                </div>
                <div class="grid grid-cols-4 items-center gap-4">
                  <Label class="text-right text-xs">{{ t("connection.proxyPassword") }}</Label>
                  <Input
                    v-model="form.proxy_password"
                    type="password"
                    class="col-span-3"
                    :placeholder="t('connection.proxyPasswordPlaceholder')"
                    :disabled="!form.proxy_enabled"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter class="flex min-w-0 items-center gap-2 sm:flex-nowrap">
          <div class="mr-auto flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden">
            <Button
              v-if="!editingId"
              variant="outline"
              class="shrink-0"
              :disabled="isSaving"
              @click="backToDatabasePicker"
            >
              <ArrowLeft class="h-4 w-4" />
              {{ t("connection.back") }}
            </Button>
            <template v-if="testResult">
              <span
                class="block min-w-0 flex-1 basis-0 truncate text-xs"
                :class="testResult.ok ? 'text-green-600' : 'text-red-600'"
                :title="testResultMessage"
                role="status"
                aria-live="polite"
              >
                {{ testResultMessage }}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                class="h-5 w-5 shrink-0"
                :title="t('connection.copyTestResult')"
                :aria-label="t('connection.copyTestResult')"
                @click="copyTestResult"
              >
                <Copy class="h-3 w-3" />
              </Button>
            </template>
          </div>
          <Button variant="outline" class="shrink-0" :disabled="isTesting || isSaving" @click="testConnection">
            {{ isTesting ? t("connection.testing") : t("connection.test") }}
          </Button>
          <Button
            class="shrink-0"
            @click="save"
            :disabled="
              isSaving ||
              (!form.host &&
                !(mongoUseUrl && form.connection_string) &&
                !(form.db_type === 'jdbc' && form.connection_string))
            "
          >
            {{
              isSaving
                ? t("common.loading")
                : editingId || isJdbcConnection
                  ? t("connection.save")
                  : t("connection.saveAndConnect")
            }}
          </Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
