<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/tauri";

const { t } = useI18n();
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
  ssl: false,
  connection_string: undefined,
});

const form = ref(defaultForm());
const selectedType = ref("mysql");
const customDriverName = ref("");
const mongoUseUrl = ref(false);

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
  custom_mysql:    { type: "mysql",    port: 3306, user: "root",     label: "Custom MySQL-compatible",       icon: "mysql",    urlParams: "" },
  custom_postgres: { type: "postgres", port: 5432, user: "postgres", label: "Custom PostgreSQL-compatible",  icon: "postgres", urlParams: "" },
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
      ssl: config.ssl || false,
      connection_string: config.connection_string,
    };
    selectedType.value = profile;
    mongoUseUrl.value = !!config.connection_string;
    customDriverName.value = isCustomCompatibleProfile() ? (config.driver_label || "") : "";
  } else {
    editingId.value = null;
    form.value = defaultForm();
    selectedType.value = "mysql";
    customDriverName.value = "";
  }
  testResult.value = null;
});

const isEditing = ref(false);
watch(() => editingId.value, (v) => { isEditing.value = !!v; });

function onDbTypeChange(val: string) {
  customDriverName.value = "";
  applyProfile(val, !!editingId.value);
}

const iconTypeMap: Record<string, string> = {
  mysql: "mysql", postgres: "postgres", sqlite: "sqlite", redis: "redis",
  mongodb: "mongodb", duckdb: "duckdb", clickhouse: "clickhouse", sqlserver: "sqlserver",
  oracle: "oracle",
  elasticsearch: "elasticsearch",
  mariadb: "mariadb", tidb: "tidb", oceanbase: "oceanbase", goldendb: "goldendb",
  opengauss: "opengauss", gaussdb: "gaussdb", kingbase: "kingbase", vastbase: "vastbase",
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
  { value: "custom_mysql", label: "Custom MySQL-compatible" },
];

const pgCompat = [
  { value: "opengauss", label: "openGauss" },
  { value: "gaussdb", label: "GaussDB" },
  { value: "kingbase", label: "KingBase" },
  { value: "vastbase", label: "Vastbase" },
  { value: "custom_postgres", label: "Custom PostgreSQL-compatible" },
];

watch(customDriverName, (value) => {
  if (isCustomCompatibleProfile()) {
    form.value.driver_label = value.trim() || selectedProfile().label;
  }
});

async function testConnection() {
  isTesting.value = true;
  testResult.value = null;
  try {
    const config: ConnectionConfig = { ...form.value, id: editingId.value || crypto.randomUUID() };
    const msg = await api.testConnection(config);
    testResult.value = { ok: true, message: msg };
  } catch (e: any) {
    testResult.value = { ok: false, message: String(e) };
  } finally {
    isTesting.value = false;
  }
}

function resetForm() {
  editingId.value = null;
  form.value = defaultForm();
  selectedType.value = "mysql";
  mongoUseUrl.value = false;
  testResult.value = null;
}

watch(open, (value) => {
  if (!value) resetForm();
});

async function save() {
  if (isSaving.value) return;
  isSaving.value = true;
  testResult.value = null;
  try {
    if (editingId.value) {
      const updated: ConnectionConfig = { ...form.value, id: editingId.value };
      store.updateConnection(updated);
      store.stopEditing();
    } else {
      const config: ConnectionConfig = { ...form.value, id: crypto.randomUUID() };
      store.addConnection(config);
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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ editingId ? t('connection.editTitle') : t('connection.title') }}</DialogTitle>
      </DialogHeader>

      <div class="grid gap-4 py-4">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.name') }}</Label>
          <Input v-model="form.name" class="col-span-3" :placeholder="t('connection.namePlaceholder')" />
        </div>

        <div class="grid grid-cols-4 items-center gap-4">
          <Label class="text-right">{{ t('connection.type') }}</Label>
          <Select :model-value="selectedType" @update:model-value="(val: any) => onDbTypeChange(String(val))">
            <SelectTrigger class="col-span-3">
              <div class="flex items-center gap-2">
                <DatabaseIcon :db-type="iconTypeMap[selectedType] || selectedType" class="w-4 h-4" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem v-for="opt in dbOptions" :key="opt.value" :value="opt.value">
                  <div class="flex items-center gap-2">
                    <DatabaseIcon :db-type="iconTypeMap[opt.value]" class="w-3.5 h-3.5" />
                    {{ opt.label }}
                  </div>
                </SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel class="text-xs text-muted-foreground">MySQL {{ t('connection.compatible') }}</SelectLabel>
                <SelectItem v-for="opt in mysqlCompat" :key="opt.value" :value="opt.value">
                  <div class="flex items-center gap-2">
                    <DatabaseIcon :db-type="iconTypeMap[opt.value]" class="w-3.5 h-3.5" />
                    {{ opt.label }}
                  </div>
                </SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel class="text-xs text-muted-foreground">PostgreSQL {{ t('connection.compatible') }}</SelectLabel>
                <SelectItem v-for="opt in pgCompat" :key="opt.value" :value="opt.value">
                  <div class="flex items-center gap-2">
                    <DatabaseIcon :db-type="iconTypeMap[opt.value]" class="w-3.5 h-3.5" />
                    {{ opt.label }}
                  </div>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
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
            <Input v-model="form.host" class="col-span-3" placeholder="/path/to/database.db" />
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

          <div v-if="form.db_type === 'mysql' || form.db_type === 'postgres'" class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.urlParams') }}</Label>
            <Input v-model="form.url_params" class="col-span-3" :placeholder="form.db_type === 'postgres' ? 'sslmode=disable' : 'charset=utf8mb4'" />
          </div>
        </template>

        <!-- SSH Tunnel (not for SQLite) -->
        <template v-if="form.db_type !== 'sqlite'">
          <div class="grid grid-cols-4 items-center gap-4 pt-2 border-t">
            <Label class="text-right text-xs">{{ t('connection.sshTunnel') }}</Label>
            <div class="col-span-3">
              <input type="checkbox" v-model="form.ssh_enabled" class="mr-2" />
              <span class="text-xs text-muted-foreground">{{ t('connection.sshEnable') }}</span>
            </div>
          </div>
          <template v-if="form.ssh_enabled">
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right text-xs">{{ t('connection.sshHost') }}</Label>
              <Input v-model="form.ssh_host" class="col-span-2" placeholder="ssh.example.com" />
              <Input v-model.number="form.ssh_port" type="number" class="col-span-1" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right text-xs">{{ t('connection.sshUser') }}</Label>
              <Input v-model="form.ssh_user" class="col-span-3" placeholder="root" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right text-xs">{{ t('connection.sshPassword') }}</Label>
              <Input v-model="form.ssh_password" type="password" class="col-span-3" :placeholder="t('connection.sshPasswordPlaceholder')" />
            </div>
            <div class="grid grid-cols-4 items-center gap-4">
              <Label class="text-right text-xs">{{ t('connection.sshKeyPath') }}</Label>
              <Input v-model="form.ssh_key_path" class="col-span-3" placeholder="~/.ssh/id_rsa" />
            </div>
          </template>
        </template>
      </div>

      <DialogFooter class="flex items-center gap-2">
        <span v-if="testResult" :class="testResult.ok ? 'text-green-500' : 'text-red-500'" class="text-sm mr-auto">
          {{ testResult.ok ? t('connection.testSuccess') : testResult.message }}
        </span>
        <Button variant="outline" :disabled="isTesting || isSaving" @click="testConnection">
          {{ isTesting ? t('connection.testing') : t('connection.test') }}
        </Button>
        <Button @click="save" :disabled="isSaving || !form.name || (!form.host && !(mongoUseUrl && form.connection_string))">
          {{ isSaving ? t('common.loading') : (editingId ? t('connection.save') : t('connection.saveAndConnect')) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
