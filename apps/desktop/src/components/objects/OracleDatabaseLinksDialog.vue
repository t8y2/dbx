<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { alterOracleDatabaseLinkSql, createOracleDatabaseLinkSql, createOceanBaseDatabaseLinkSql, dropOracleDatabaseLinkSql, redactOracleDatabaseLinkError, testOracleDatabaseLinkSql, type OracleDatabaseLink } from "@/lib/database/oracleDatabaseLinks";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
const props = defineProps<{ open: boolean; connectionId: string; database: string; name?: string; owner?: string }>();
const emit = defineEmits<{ "update:open": [boolean]; changed: [] }>();
const { t } = useI18n();
const store = useConnectionStore();
const oceanbase = computed(() => effectiveDatabaseTypeForConnection(store.getConfig(props.connectionId)) === "oceanbase-oracle");
const tenant = ref("");
const protocol = ref<"OB" | "OCI">("OB");
const cluster = ref("");
const links = ref<OracleDatabaseLink[]>([]);
const sessionUser = ref("");
const selected = ref<OracleDatabaseLink>();
const search = ref("");
const busy = ref(false);
const message = ref("");
const error = ref("");
const mode = ref<"create" | "alter" | "drop" | "">("");
const name = ref("");
const username = ref("");
const password = ref("");
const host = ref("");
const publicLink = ref(false);
const filtered = computed(() => links.value.filter((link) => `${link.name} ${link.owner} ${link.username} ${link.host}`.toLowerCase().includes(search.value.toLowerCase())));
const selectedIsShadowed = computed(() => !oceanbase.value && selected.value?.owner === "PUBLIC" && links.value.some((link) => link.owner !== "PUBLIC" && link.name.toUpperCase() === selected.value?.name.toUpperCase()));
let revision = 0;
onBeforeUnmount(() => {
  ++revision;
});
watch(
  () => [props.open, props.connectionId, props.database, props.name, props.owner],
  () => {
    ++revision;
    mode.value = "";
    password.value = "";
    selected.value = undefined;
    links.value = [];
    sessionUser.value = "";
    busy.value = false;
    error.value = "";
    message.value = "";
    if (props.open) void reload();
  },
  { immediate: true, flush: "sync" },
);
async function reload() {
  if (!props.open) return;
  const connectionId = props.connectionId,
    database = props.database;
  const requested = ++revision;
  busy.value = true;
  error.value = "";
  try {
    const result = await store.listOracleDatabaseLinks(connectionId, database);
    if (requested !== revision) return;
    const identity = await api.executeQuery(connectionId, database, "SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL", undefined, undefined, { maxRows: 1, timeoutSecs: 15 });
    if (requested !== revision) return;
    sessionUser.value = String(identity.rows[0]?.[0] || "");
    links.value = result;
    selected.value = result.find((link) => link.name === (selected.value?.name || props.name) && link.owner === (selected.value?.owner || props.owner));
  } catch (e) {
    if (requested === revision) error.value = String(e);
  } finally {
    if (requested === revision) busy.value = false;
  }
}
function begin(next: "create" | "alter" | "drop") {
  if (busy.value || !sessionUser.value || !props.open || (next === "alter" && oceanbase.value)) return;
  mode.value = next;
  password.value = "";
  error.value = "";
  message.value = "";
  if (next === "create") {
    name.value = "";
    username.value = "";
    host.value = "";
    publicLink.value = false;
    tenant.value = "";
    protocol.value = "OB";
    cluster.value = "";
  }
}
async function execute(sql: string) {
  if (!sessionUser.value) throw new Error("Unable to determine the Oracle session user");
  const connectionId = props.connectionId,
    database = props.database,
    schema = sessionUser.value,
    requested = revision;
  return executeWithProductionSqlGuard({
    connection: store.getConfig(connectionId),
    database,
    sql,
    source: t("tree.databaseLinks"),
    execute: () => {
      if (requested !== revision || !props.open) throw new Error("Database link target changed");
      return api.executeQuery(connectionId, database, sql, schema, undefined, { maxRows: 1, timeoutSecs: 15 });
    },
  });
}
async function save() {
  if (busy.value || !props.open || !sessionUser.value) return;
  const requested = revision,
    secret = password.value;
  busy.value = true;
  error.value = "";
  try {
    const sql =
      mode.value === "create"
        ? oceanbase.value
          ? createOceanBaseDatabaseLinkSql({ name: name.value.trim(), username: username.value.trim(), password: password.value, host: host.value, public: publicLink.value, tenant: tenant.value, protocol: protocol.value, cluster: protocol.value === "OB" ? cluster.value : undefined })
          : createOracleDatabaseLinkSql({ name: name.value.trim(), username: username.value.trim(), password: password.value, host: host.value, public: publicLink.value })
        : mode.value === "alter" && selected.value && !oceanbase.value
          ? alterOracleDatabaseLinkSql(selected.value, password.value)
          : mode.value === "drop" && selected.value
            ? dropOracleDatabaseLinkSql(selected.value, oceanbase.value ? "oceanbase-oracle" : "oracle")
            : "";
    if (!sql) return;
    const result = await execute(sql);
    if (requested !== revision || result === undefined) return;
    mode.value = "";
    password.value = "";
    message.value = t("databaseLinks.saved");
    emit("changed");
    await reload();
  } catch (e) {
    if (requested === revision) error.value = redactOracleDatabaseLinkError(e, secret);
  } finally {
    if (requested === revision) busy.value = false;
  }
}
async function test() {
  if (!selected.value || busy.value || selectedIsShadowed.value || !props.open) return;
  const requested = revision;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await execute(testOracleDatabaseLinkSql(selected.value, oceanbase.value ? "oceanbase-oracle" : "oracle"));
    if (requested !== revision || result === undefined) return;
    message.value = t("databaseLinks.testSuccess");
  } catch (e) {
    if (requested === revision) error.value = String(e);
  } finally {
    if (requested === revision) busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
      <DialogHeader
        ><DialogTitle>{{ t("tree.databaseLinks") }}</DialogTitle></DialogHeader
      >
      <div class="flex gap-2">
        <Input v-model="search" :placeholder="t('databaseLinks.search')" :aria-label="t('databaseLinks.search')" />
        <Button variant="outline" :disabled="busy" @click="reload">{{ t("common.refresh") }}</Button>
        <Button :disabled="busy" @click="begin('create')">{{ t("databaseLinks.create") }}</Button>
      </div>
      <div class="max-h-64 overflow-auto border rounded-md">
        <table class="w-full text-sm text-left">
          <thead class="sticky top-0 bg-muted">
            <tr>
              <th class="p-2">{{ t("databaseLinks.name") }}</th>
              <th class="p-2">{{ t("databaseLinks.owner") }}</th>
              <th class="p-2">{{ t("databaseLinks.username") }}</th>
              <th class="p-2">{{ t("databaseLinks.host") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="link in filtered"
              :key="`${link.owner}:${link.name}`"
              class="cursor-pointer hover:bg-muted/60"
              :class="selected === link ? 'bg-muted' : ''"
              @click="
                selected = link;
                mode = '';
                password = '';
              "
            >
              <td class="p-2">
                <button class="text-left" @click="selected = link">{{ link.name }}</button>
              </td>
              <td class="p-2">{{ link.owner }}</td>
              <td class="p-2">{{ link.username || "—" }}</td>
              <td class="p-2 break-all">{{ link.host }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!busy && !filtered.length" class="p-4 text-sm text-muted-foreground">{{ t("databaseLinks.empty") }}</p>
      </div>
      <template v-if="selected && !mode">
        <p class="text-sm break-all">{{ selected.name }} · {{ selected.owner }} · {{ selected.created }}</p>
        <p v-if="selectedIsShadowed" class="text-sm text-muted-foreground">{{ t("databaseLinks.shadowed") }}</p>
        <p v-if="oceanbase && selected.canDrop === false" class="text-sm text-muted-foreground">{{ t("databaseLinks.oceanbaseSharedReadOnly") }}</p>
        <p v-if="oceanbase" class="text-sm text-muted-foreground">{{ t("databaseLinks.oceanbaseRecreateHint") }}</p>
        <div class="flex gap-2">
          <Button variant="outline" :disabled="busy || selectedIsShadowed" @click="test">{{ t("databaseLinks.test") }}</Button
          ><Button v-if="!oceanbase" variant="outline" :disabled="busy || !selected.username" @click="begin('alter')">{{ t("databaseLinks.alter") }}</Button
          ><Button variant="destructive" :disabled="busy || selected.canDrop === false" @click="begin('drop')">{{ t("common.delete") }}</Button>
        </div>
      </template>
      <form v-if="mode" class="space-y-3 border-t pt-3" @submit.prevent="save">
        <template v-if="mode === 'create'">
          <label class="block text-sm">{{ t("databaseLinks.name") }}<Input v-model="name" required autocomplete="off" /></label>
          <label class="block text-sm">{{ t("databaseLinks.username") }}<Input v-model="username" required autocomplete="off" /></label>
          <label class="block text-sm">{{ t("databaseLinks.host") }}<Input v-model="host" required :placeholder="oceanbase ? 'host:2881 or host:1521/service' : '//host:1521/service'" autocomplete="off" /></label>
          <template v-if="oceanbase">
            <label class="block text-sm"
              >{{ t("databaseLinks.remoteProtocol")
              }}<select v-model="protocol" class="w-full rounded-md border p-2">
                <option value="OB">OceanBase (OB)</option>
                <option value="OCI">Oracle (OCI)</option>
              </select></label
            >
            <label v-if="protocol === 'OB'" class="block text-sm">{{ t("databaseLinks.remoteTenant") }}<Input v-model="tenant" required autocomplete="off" /></label>
            <label v-if="protocol === 'OB'" class="block text-sm">{{ t("databaseLinks.remoteCluster") }}<Input v-model="cluster" autocomplete="off" /></label>
          </template>
          <label class="flex items-center gap-2 text-sm"><input v-model="publicLink" type="checkbox" />{{ t(oceanbase ? "databaseLinks.oceanbasePublic" : "databaseLinks.public") }}</label>
        </template>
        <p v-if="mode === 'alter'" class="text-sm">{{ t("databaseLinks.alterHint", { name: selected?.name }) }}</p>
        <label v-if="mode !== 'drop'" class="block text-sm">{{ t("databaseLinks.password") }}<Input v-model="password" type="password" required autocomplete="new-password" /></label>
        <p v-else class="text-sm">{{ t("databaseLinks.dropConfirm", { name: selected?.name, owner: selected?.owner }) }}</p>
        <div class="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="
              mode = '';
              password = '';
            "
            >{{ t("common.cancel") }}</Button
          ><Button type="submit" :disabled="busy" :variant="mode === 'drop' ? 'destructive' : 'default'">{{ t(mode === "drop" ? "common.delete" : "common.save") }}</Button>
        </div>
      </form>
      <p v-if="busy" role="status" class="text-sm text-muted-foreground">{{ t("common.loading") }}</p>
      <p v-if="error" role="alert" class="text-sm text-destructive whitespace-pre-wrap break-all">{{ error }}</p>
      <p v-if="message" role="status" class="text-sm">{{ message }}</p>
    </DialogContent>
  </Dialog>
</template>
