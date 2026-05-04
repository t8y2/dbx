<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/tauri";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ChevronRight, Copy, FolderOpen, Grid3X3, List, Search } from "lucide-vue-next";

type DbOption = { value: string; label: string };
type DbCategory = { key: string; title: string; options: DbOption[] };
type DialogStep = "select" | "config";
type DbPickerView = "icon" | "list";
type ConfigTab = "connection" | "ssh";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  editConfig?: ConnectionConfig;
}>();

const emit = defineEmits<{
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
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
  ssl: false,
  connection_string: undefined,
});

const form = ref(defaultForm());
const selectedType = ref("mysql");
const customDriverName = ref("");
const mongoUseUrl = ref(false);
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

const driverProfiles: Record<string, { type: DatabaseType; port: number; user: string; label: string; icon: string; urlParams?: string }> = {
  mysql:      { type: "mysql",      port: 3306,  user: "root",     label: "MySQL",       icon: "mysql",    urlParams: "" },
  postgres:   { type: "postgres",   port: 5432,  user: "postgres", label: "PostgreSQL",  icon: "postgres", urlParams: "" },
  redis:      { type: "redis",      port: 6379,  user: "",         label: "Redis",       icon: "redis" },
  sqlite:     { type: "sqlite",     port: 0,     user: "",         label: "SQLite",      icon: "sqlite" },
  duckdb:     { type: "duckdb",     port: 0,     user: "",         label: "DuckDB",      icon: "duckdb" },
  mongodb:    { type: "mongodb",    port: 27017, user: "",         label: "MongoDB",     icon: "mongodb" },
  clickhouse: { type: "clickhouse", port: 8123,  user: "default",  label: "ClickHouse",  icon: "clickhouse" },
  sqlserver:  { type: "sqlserver",  port: 1433,  user: "sa",       label: "SQL Server",  icon: "sqlserver" },
  oracle:     { type: "oracle",     port: 1521,  user: "system",   label: "Oracle",      icon: "oracle" },
  elasticsearch: { type: "elasticsearch", port: 9200, user: "", label: "Elasticsearch", icon: "elasticsearch" },
  mariadb:    { type: "mysql",      port: 3306,  user: "root",     label: "MariaDB",     icon: "mariadb" },
  tidb:       { type: "mysql",      port: 4000,  user: "root",     label: "TiDB",        icon: "tidb" },
  oceanbase:  { type: "mysql",      port: 2881,  user: "root",     label: "OceanBase",   icon: "oceanbase" },
  goldendb:   { type: "mysql",      port: 3306,  user: "root",     label: "GoldenDB",    icon: "goldendb" },
  opengauss:  { type: "postgres",   port: 5432,  user: "gaussdb",  label: "openGauss",   icon: "opengauss", urlParams: "sslmode=disable" },
  gaussdb:    { type: "postgres",   port: 5432,  user: "gaussdb",  label: "GaussDB",     icon: "gaussdb" },
  kingbase:   { type: "postgres",   port: 54321, user: "system",   label: "KingBase",    icon: "kingbase" },
  vastbase:   { type: "postgres",   port: 5432,  user: "vastbase", label: "Vastbase",    icon: "vastbase" },
  doris:      { type: "mysql",      port: 9030,  user: "root",     label: "Doris",       icon: "doris",    urlParams: "" },
  selectdb:   { type: "mysql",      port: 9030,  user: "root",     label: "SelectDB",    icon: "selectdb", urlParams: "" },
  starrocks:  { type: "mysql",      port: 9030,  user: "root",     label: "StarRocks",   icon: "starrocks", urlParams: "" },
  redshift:   { type: "postgres",   port: 5439,  user: "awsuser",  label: "Redshift",    icon: "redshift" },
  cockroachdb:{ type: "postgres",   port: 26257, user: "root",     label: "CockroachDB", icon: "cockroachdb" },
  dm:         { type: "postgres",   port: 5236,  user: "SYSDBA",   label: "DM (Dameng)", icon: "dm" },
  tdengine:   { type: "mysql",      port: 6030,  user: "root",     label: "TDengine",    icon: "tdengine" },
  custom_mysql:    { type: "mysql",    port: 3306, user: "root",     label: "Custom",       icon: "mysql",    urlParams: "" },
  custom_postgres: { type: "postgres", port: 5432, user: "postgres", label: "Custom",  icon: "postgres", urlParams: "" },
};

function profileForConfig(config: ConnectionConfig) {
  if (config.driver_profile && driverProfiles[config.driver_profile]) return config.driver_profile;
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
    ? (customDriverName.value.trim() || profile.label)
    : profile.label;

  if (!preserveConnectionFields) {
    form.value.port = profile.port;
    form.value.username = profile.user;
    form.value.url_params = profile.urlParams || "";
  }
}

watch(() => props.editConfig, (config) => {
  if (config) {
    const profile = profileForConfig(config);
    editingId.value = config.id;
    form.value = {
      name: config.name,
      db_type: config.db_type,
      driver_profile: profile,
      driver_label: config.driver_label || driverProfiles[profile]?.label || config.db_type,
      url_params: config.url_params || "",
      host: config.host,
      port: config.port,
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
      ssl: config.ssl || false,
      connection_string: config.connection_string,
    };
    selectedType.value = profile;
    mongoUseUrl.value = !!config.connection_string;
    customDriverName.value = isCustomCompatibleProfile() ? (config.driver_label || "") : "";
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
});

const isEditing = ref(false);
watch(() => editingId.value, (v) => { isEditing.value = !!v; });

function onDbTypeChange(val: string) {
  customDriverName.value = "";
  applyProfile(val, !!editingId.value);
  resetTestState();
}

const iconTypeMap: Record<string, string> = {
  mysql: "mysql", postgres: "postgres", sqlite: "sqlite", redis: "redis",
  mongodb: "mongodb", duckdb: "duckdb", clickhouse: "clickhouse", sqlserver: "sqlserver",
  oracle: "oracle",
  elasticsearch: "elasticsearch",
  mariadb: "mariadb", tidb: "tidb", oceanbase: "oceanbase", goldendb: "goldendb",
  opengauss: "opengauss", gaussdb: "gaussdb", kingbase: "kingbase", vastbase: "vastbase",
  doris: "doris", selectdb: "selectdb", starrocks: "starrocks", redshift: "redshift",
  cockroachdb: "cockroachdb", tdengine: "tdengine", dm: "dm",
  custom_mysql: "mysql", custom_postgres: "postgres",
};

const dbOptions = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "redis", label: "Redis" },
  { value: "mongodb", label: "MongoDB" },
  { value: "duckdb", label: "DuckDB" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "oracle", label: "Oracle" },
  { value: "elasticsearch", label: "Elasticsearch" },
  { value: "mariadb", label: "MariaDB" },
];

const mysqlCompat = [
  { value: "tidb", label: "TiDB" },
  { value: "oceanbase", label: "OceanBase" },
  { value: "goldendb", label: "GoldenDB" },
  { value: "doris", label: "Doris" },
  { value: "selectdb", label: "SelectDB" },
  { value: "starrocks", label: "StarRocks" },
  { value: "tdengine", label: "TDengine" },
  { value: "custom_mysql", label: "Custom" },
];

const pgCompat = [
  { value: "opengauss", label: "openGauss" },
  { value: "gaussdb", label: "GaussDB" },
  { value: "kingbase", label: "KingBase" },
  { value: "vastbase", label: "Vastbase" },
  { value: "dm", label: "DM (Dameng)" },
  { value: "redshift", label: "Redshift" },
  { value: "cockroachdb", label: "CockroachDB" },
  { value: "custom_postgres", label: "Custom" },
];

const dbCategories = computed<DbCategory[]>(() => [
  { key: "mainstream", title: t("connection.mainstream"), options: dbOptions },
  { key: "mysql", title: `MySQL ${t("connection.compatible")}`, options: mysqlCompat },
  { key: "postgres", title: `PostgreSQL ${t("connection.compatible")}`, options: pgCompat },
]);

const filteredDbCategories = computed<DbCategory[]>(() => {
  const keyword = dbSearchQuery.value.trim().toLowerCase();
  if (!keyword) return dbCategories.value;

  return dbCategories.value
    .map((category) => ({
      ...category,
      options: category.options.filter((option) => {
        const profile = driverProfiles[option.value];
        return [
          option.label,
          option.value,
          profile?.label,
          profile?.type,
          category.title,
        ].some((value) => String(value || "").toLowerCase().includes(keyword));
      }),
    }))
    .filter((category) => category.options.length > 0);
});

const hasDbPickerResults = computed(() => filteredDbCategories.value.some((category) => category.options.length > 0));
const selectedDbIcon = computed(() => iconTypeMap[selectedType.value] || selectedProfile().icon || selectedType.value);
const canUseSsh = computed(() => form.value.db_type !== "sqlite");
const testResultMessage = computed(() => {
  if (!testResult.value) return "";
  return testResult.value.ok ? t("connection.testSuccess") : testResult.value.message;
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
    const config: ConnectionConfig = { ...form.value, id: editingId.value || crypto.randomUUID() };
    const msg = await api.testConnection(config);
    if (runId !== testRunId) return;
    testResult.value = { ok: true, message: msg };
  } catch (e: any) {
    if (runId !== testRunId) return;
    testResult.value = { ok: false, message: String(e) };
  } finally {
    if (runId === testRunId) {
      isTesting.value = false;
    }
  }
}

function resetTestState() {
  testRunId += 1;
  isTesting.value = false;
  testResult.value = null;
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
  dialogStep.value = "select";
  dbPickerView.value = "icon";
  dbSearchQuery.value = "";
  configTab.value = "connection";
  resetTestState();
}

watch(open, (value) => {
  if (!value) {
    resetForm();
    return;
  }
  if (!props.editConfig) {
    resetForm();
  }
});

watch(canUseSsh, (value) => {
  if (!value && configTab.value === "ssh") {
    configTab.value = "connection";
  }
});

async function save() {
  if (isSaving.value) return;
  isSaving.value = true;
  resetTestState();
  try {
    if (editingId.value) {
      const updated: ConnectionConfig = { ...form.value, id: editingId.value };
      await store.updateConnection(updated);
      store.stopEditing();
    } else {
      const config: ConnectionConfig = { ...form.value, id: crypto.randomUUID() };
      await store.addConnection(config);
      open.value = false;
      await nextTick();
      emit("connectStarted", config.name);
      void store.connect(config)
        .then(() => {
          emit("connectSucceeded", config.name);
        })
        .catch((e: any) => {
          emit("connectFailed", String(e?.message || e));
        });
      return;
    }
    open.value = false;
  } catch (e: any) {
    testResult.value = { ok: false, message: String(e?.message || e) };
  } finally {
    isSaving.value = false;
  }
}

const dialogTitle = ref("");
watch([() => editingId.value, () => open.value], () => {
  dialogTitle.value = editingId.value ? t('connection.editTitle') : t('connection.title');
});

async function browseSshKeyPath() {
  const selected = await openFileDialog({
    title: "Select SSH Private Key",
    multiple: false,
  });
  if (selected && typeof selected === "string") {
    form.value.ssh_key_path = selected;
  }
}

function copyFilePath() {
  if (form.value.host) {
    navigator.clipboard.writeText(form.value.host);
    filePathCopied.value = true;
    setTimeout(() => {
      filePathCopied.value = false;
    }, 2000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="dialogStep === 'select' ? 'sm:max-w-[760px]' : 'sm:max-w-[560px]'">
      <DialogHeader>
        <DialogTitle>{{ editingId ? t('connection.editTitle') : t('connection.title') }}</DialogTitle>
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
              {{ t('connection.noDatabaseMatches') }}
            </div>
          </div>
        </div>

        <DialogFooter class="flex items-center gap-2">
          <div class="mr-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
            <span class="truncate">{{ t('connection.selectedDatabase') }}: {{ selectedProfile().label }}</span>
          </div>
          <Button :disabled="!hasDbPickerResults" @click="goToConnectionStep()">
            {{ t('connection.next') }}
            <ChevronRight class="h-4 w-4" />
          </Button>
        </DialogFooter>
      </template>

      <template v-else>
      <div class="space-y-3">
        <Tabs v-model="configTab" class="min-h-0">
          <div class="flex items-center justify-between border-b pb-2">
            <TabsList>
              <TabsTrigger value="connection">{{ t('connection.basicTab') }}</TabsTrigger>
              <TabsTrigger v-if="canUseSsh" value="ssh">{{ t('connection.sshTunnel') }}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="connection" class="m-0">
      <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.name') }}</Label>
          <Input v-model="form.name" class="col-span-3" :placeholder="t('connection.namePlaceholder')" />
        </div>

        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.type') }}</Label>
          <div class="col-span-3 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
            <DatabaseIcon :db-type="selectedDbIcon" class="h-4 w-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ selectedProfile().label }}</span>
          </div>
        </div>

        <div v-if="isCustomCompatibleProfile()" class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.driverName') }}</Label>
          <Input v-model="customDriverName" class="col-span-3" :placeholder="t('connection.driverNamePlaceholder')" />
        </div>

        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.color') }}</Label>
          <div class="col-span-3 flex items-center gap-1.5">
            <button
              v-for="color in colorOptions"
              :key="color.value || 'none'"
              type="button"
              class="h-6 w-6 rounded-full border ring-offset-background transition hover:scale-105"
              :class="[color.class, form.color === color.value ? 'ring-2 ring-ring ring-offset-2' : 'border-border']"
              :title="t(color.labelKey)"
              @click="form.color = color.value"
            />
          </div>
        </div>

        <!-- SQLite / DuckDB: file path only -->
        <template v-if="form.db_type === 'sqlite' || form.db_type === 'duckdb'">
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.filePath') }}</Label>
            <div class="col-span-3 space-y-1.5">
              <div class="flex items-center gap-1">
                <Input v-model="form.host" class="flex-1" :placeholder="t('connection.filePathPlaceholder')" />
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="!form.host" @click="copyFilePath">
                      <Check v-if="filePathCopied" class="h-4 w-4 text-green-600" />
                      <Copy v-else class="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ filePathCopied ? t('contextMenu.copyPathSuccess') : t('connection.copyFilePath') }}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </template>

        <!-- Redis: host, port, user, password, ssl -->
        <template v-else-if="form.db_type === 'redis'">
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.host') }}</Label>
            <Input v-model="form.host" class="col-span-2" />
            <Input v-model.number="form.port" type="number" class="col-span-1" />
          </div>
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.user') }}</Label>
            <Input v-model="form.username" class="col-span-3" placeholder="default" />
          </div>
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.password') }}</Label>
            <Input v-model="form.password" type="password" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
          </div>
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right text-xs">SSL/TLS</Label>
            <div class="col-span-3">
              <input type="checkbox" v-model="form.ssl" class="mr-2" />
              <span class="text-xs text-muted-foreground">{{ t('connection.sshEnable') }}</span>
            </div>
          </div>
        </template>

        <!-- MongoDB: URL or form -->
        <template v-else-if="form.db_type === 'mongodb'">
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right text-xs">{{ t('connection.mode') }}</Label>
            <div class="col-span-3 flex gap-2">
              <Button size="sm" :variant="mongoUseUrl ? 'outline' : 'default'" @click="mongoUseUrl = false">{{ t('connection.modeForm') }}</Button>
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
              <Label class="text-right">{{ t('connection.host') }}</Label>
              <Input v-model="form.host" class="col-span-2" />
              <Input v-model.number="form.port" type="number" class="col-span-1" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right">{{ t('connection.user') }}</Label>
              <Input v-model="form.username" class="col-span-3" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right">{{ t('connection.password') }}</Label>
              <Input v-model="form.password" type="password" class="col-span-3" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right">{{ t('connection.database') }}</Label>
              <Input v-model="form.database" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
            </div>
          </template>
        </template>

        <!-- MySQL / PostgreSQL: host, port, user, password, database -->
        <template v-else>
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.host') }}</Label>
            <Input v-model="form.host" class="col-span-2" />
            <Input v-model.number="form.port" type="number" class="col-span-1" />
          </div>

          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.user') }}</Label>
            <Input v-model="form.username" class="col-span-3" />
          </div>

          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.password') }}</Label>
            <Input v-model="form.password" type="password" class="col-span-3" />
          </div>

          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.database') }}</Label>
            <Input v-model="form.database" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
          </div>

          <div v-if="selectedType === 'dm'" class="grid grid-cols-4 items-center gap-4">
            <span />
            <p class="col-span-3 text-xs text-muted-foreground">{{ t('connection.dmCompatHint') }}</p>
          </div>

          <div v-if="form.db_type === 'mysql' || form.db_type === 'postgres'" class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.urlParams') }}</Label>
            <Input v-model="form.url_params" class="col-span-3" :placeholder="form.db_type === 'postgres' ? 'sslmode=disable' : 'charset=utf8mb4'" />
          </div>
        </template>

      </div>
          </TabsContent>

          <TabsContent v-if="canUseSsh" value="ssh" class="m-0">
            <div class="grid gap-4 py-4 pr-2 max-h-[65vh] overflow-y-auto">
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshTunnel') }}</Label>
                <label class="col-span-3 flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" v-model="form.ssh_enabled" class="mr-0" />
                  <span class="text-xs text-muted-foreground">{{ t('connection.sshEnable') }}</span>
                </label>
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshHost') }}</Label>
                <Input v-model="form.ssh_host" class="col-span-2" placeholder="ssh.example.com" :disabled="!form.ssh_enabled" />
                <Input v-model.number="form.ssh_port" type="number" class="col-span-1" :disabled="!form.ssh_enabled" />
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshUser') }}</Label>
                <Input v-model="form.ssh_user" class="col-span-3" placeholder="root" :disabled="!form.ssh_enabled" />
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshPassword') }}</Label>
                <Input v-model="form.ssh_password" type="password" class="col-span-3" :placeholder="t('connection.sshPasswordPlaceholder')" :disabled="!form.ssh_enabled" />
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshKeyPath') }}</Label>
                <div class="col-span-3 flex items-center gap-1">
                  <Input v-model="form.ssh_key_path" class="flex-1" placeholder="~/.ssh/id_rsa" :disabled="!form.ssh_enabled" />
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button variant="outline" size="icon" class="h-9 w-9 shrink-0" :disabled="!form.ssh_enabled" @click="browseSshKeyPath">
                        <FolderOpen class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ t('connection.sshKeyPathBrowse') }}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label class="text-right text-xs">{{ t('connection.sshKeyPassphrase') }}</Label>
                <Input v-model="form.ssh_key_passphrase" type="password" class="col-span-3" :placeholder="t('connection.sshKeyPassphrasePlaceholder')" :disabled="!form.ssh_enabled" />
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <span />
                <label
                  class="col-span-3 flex items-center gap-2"
                  :class="form.ssh_enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'"
                >
                  <input type="checkbox" v-model="form.ssh_expose_lan" class="mr-0" :disabled="!form.ssh_enabled" />
                  <span class="text-xs text-muted-foreground">{{ t('connection.sshExposeLan') }}</span>
                </label>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <DialogFooter class="flex min-w-0 items-center gap-2 sm:flex-nowrap">
        <div class="mr-auto flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden">
          <Button v-if="!editingId" variant="outline" class="shrink-0" :disabled="isSaving" @click="backToDatabasePicker">
            <ArrowLeft class="h-4 w-4" />
            {{ t('connection.back') }}
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
          {{ isTesting ? t('connection.testing') : t('connection.test') }}
        </Button>
        <Button class="shrink-0" @click="save" :disabled="isSaving || !form.name || (!form.host && !(mongoUseUrl && form.connection_string))">
          {{ isSaving ? t('common.loading') : (editingId ? t('connection.save') : t('connection.saveAndConnect')) }}
        </Button>
      </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
