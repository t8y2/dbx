<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/tauri";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  editConfig?: ConnectionConfig;
}>();

const store = useConnectionStore();
const isTesting = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);
const editingId = ref<string | null>(null);

const defaultForm = (): Omit<ConnectionConfig, "id"> => ({
  name: "",
  db_type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  database: undefined,
  ssh_enabled: false,
  ssh_host: "",
  ssh_port: 22,
  ssh_user: "",
  ssh_password: "",
  ssh_key_path: "",
});

const form = ref(defaultForm());

watch(() => props.editConfig, (config) => {
  if (config) {
    editingId.value = config.id;
    form.value = {
      name: config.name,
      db_type: config.db_type,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      ssh_enabled: config.ssh_enabled || false,
      ssh_host: config.ssh_host || "",
      ssh_port: config.ssh_port || 22,
      ssh_user: config.ssh_user || "",
      ssh_password: config.ssh_password || "",
      ssh_key_path: config.ssh_key_path || "",
    };
  } else {
    editingId.value = null;
    form.value = defaultForm();
  }
  testResult.value = null;
});

const isEditing = ref(false);
watch(() => editingId.value, (v) => { isEditing.value = !!v; });

function onDbTypeChange(val: string) {
  form.value.db_type = val as DatabaseType;
  if (!editingId.value) {
    if (val === "mysql") { form.value.port = 3306; form.value.username = "root"; }
    else if (val === "postgres") { form.value.port = 5432; form.value.username = "postgres"; }
    else if (val === "redis") { form.value.port = 6379; form.value.username = ""; }
    else if (val === "sqlite" || val === "duckdb") { form.value.port = 0; form.value.username = ""; }
    else if (val === "mongodb") { form.value.port = 27017; form.value.username = ""; }
    else if (val === "clickhouse") { form.value.port = 8123; form.value.username = "default"; }
    else if (val === "sqlserver") { form.value.port = 1433; form.value.username = "sa"; }
  }
}

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

async function save() {
  if (editingId.value) {
    const updated: ConnectionConfig = { ...form.value, id: editingId.value };
    store.updateConnection(updated);
    open.value = false;
  } else {
    const config: ConnectionConfig = { ...form.value, id: crypto.randomUUID() };
    store.addConnection(config);
    await store.connect(config);
    open.value = false;
  }
  editingId.value = null;
  form.value = defaultForm();
  testResult.value = null;
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
          <Select :model-value="form.db_type" @update:model-value="(val: any) => onDbTypeChange(String(val))">
            <SelectTrigger class="col-span-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mysql">MySQL</SelectItem>
              <SelectItem value="postgres">PostgreSQL</SelectItem>
              <SelectItem value="sqlite">SQLite</SelectItem>
              <SelectItem value="redis">Redis</SelectItem>
              <SelectItem value="mongodb">MongoDB</SelectItem>
              <SelectItem value="duckdb">DuckDB</SelectItem>
              <SelectItem value="clickhouse">ClickHouse</SelectItem>
              <SelectItem value="sqlserver">SQL Server</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- SQLite / DuckDB: file path only -->
        <template v-if="form.db_type === 'sqlite' || form.db_type === 'duckdb'">
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.filePath') }}</Label>
            <Input v-model="form.host" class="col-span-3" placeholder="/path/to/database.db" />
          </div>
        </template>

        <!-- Redis: host, port, password -->
        <template v-else-if="form.db_type === 'redis'">
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.host') }}</Label>
            <Input v-model="form.host" class="col-span-2" />
            <Input v-model.number="form.port" type="number" class="col-span-1" />
          </div>
          <div class="grid grid-cols-4 items-center gap-4">
            <Label class="text-right">{{ t('connection.password') }}</Label>
            <Input v-model="form.password" type="password" class="col-span-3" :placeholder="t('connection.databasePlaceholder')" />
          </div>
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
        <Button variant="outline" :disabled="isTesting" @click="testConnection">
          {{ isTesting ? t('connection.testing') : t('connection.test') }}
        </Button>
        <Button @click="save" :disabled="!form.name || !form.host">
          {{ editingId ? t('connection.save') : t('connection.saveAndConnect') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
