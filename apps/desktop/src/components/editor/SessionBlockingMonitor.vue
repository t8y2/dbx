<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Network } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConnectionConfig } from "@/types/database";
import { connectionDriverLabel } from "@/lib/connection/connectionPresentation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSessionBlockingMonitor } from "@/composables/useSessionBlockingMonitor";
import { blockingPaths, type MonitorContext } from "@/lib/database/sessionBlockingMonitor";
import { sessionBlockingMessages } from "@/lib/database/sessionBlockingMessages";

const props = defineProps<{ connection: ConnectionConfig; database: string }>();
const { t } = useI18n({ useScope: "local", fallbackLocale: "en-US", messages: sessionBlockingMessages });
const open = ref(false);
const connections = useConnectionStore();
const context = computed<MonitorContext | null>(() => {
  const engine = props.connection.db_type;
  return open.value && connections.connectedIds.has(props.connection.id) && (engine === "oracle" || engine === "oceanbase-oracle") ? { connectionId: props.connection.id, database: props.database, engine } : null;
});
const monitor = useSessionBlockingMonitor(context);
const { snapshot, error, pending, stale, autoRefresh, canRefresh } = monitor;
const chains = computed(() => {
  if (!snapshot.value) return [];
  const data = snapshot.value;
  const identities = new Map(data.sessions.map((node) => [node.key, node.identity]));
  return [...new Set(data.edges.map((edge) => edge.waiter))].flatMap((start) => blockingPaths(data, start).map((path) => ({ label: path.keys.map((id) => identities.get(id) ?? t("missing")).join(" → "), end: path.end })));
});
</script>

<template>
  <Button variant="ghost" size="icon" class="h-6 w-6" :aria-label="t('title')" :title="t('title')" @click="open = true"><Network class="h-3.5 w-3.5" /></Button>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[1100px] max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader
        ><DialogTitle>{{ t("title") }}</DialogTitle
        ><DialogDescription>{{ t("description") }}</DialogDescription></DialogHeader
      >
      <div class="space-y-3 overflow-auto text-sm">
        <p class="text-muted-foreground">{{ connection.db_type }} · {{ connection.driver_profile || connection.db_type }} · {{ connectionDriverLabel(connection) }}</p>
        <p>{{ t("scope") }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <Button :disabled="!canRefresh" @click="monitor.refresh()">{{ t("refresh") }}</Button>
          <Button v-if="pending" variant="outline" @click="monitor.cancel()">{{ t("cancel") }}</Button>
          <label class="flex items-center gap-2"><input v-model="autoRefresh" type="checkbox" :disabled="!context" />{{ t("auto") }}</label>
        </div>
        <p class="text-muted-foreground">{{ t("frequency") }}</p>
        <p v-if="!context" role="status">{{ t("status.connection_changed") }}</p>
        <p v-if="error" role="alert">{{ t(`status.${error}`) }}</p>
        <template v-if="snapshot">
          <p>
            {{ t("sample") }}: {{ snapshot.startedAt }} — {{ snapshot.completedAt }} <strong v-if="stale">· {{ t("stale") }}</strong>
          </p>
          <p v-for="reason in snapshot.limitations" :key="reason" role="status">{{ t(`status.${reason}`) }}</p>
          <p v-if="!snapshot.sessions.length">{{ t("empty") }}</p>
          <table v-else class="w-full text-left">
            <thead>
              <tr>
                <th>{{ t("identity") }}</th>
                <th>{{ t("state") }}</th>
                <th>{{ t("wait") }}</th>
                <th>SQL ID</th>
                <th>{{ t("blocking") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="session in snapshot.sessions" :key="session.key">
                <td class="break-all">
                  {{ session.identity }}<small v-if="!session.visible" class="block">{{ t("missing") }}</small>
                </td>
                <td>{{ session.state }}</td>
                <td>{{ session.wait }}</td>
                <td>{{ session.sqlId }}</td>
                <td>{{ t(`status.${session.blocking}`) }}</td>
              </tr>
            </tbody>
          </table>
          <h3 class="font-medium">{{ t("chains") }}</h3>
          <p v-if="!chains.length">{{ t("noEdges") }}</p>
          <p v-for="(chain, index) in chains" :key="index" class="break-all">{{ chain.label }} · {{ t(`status.${chain.end}`) }}</p>
        </template>
        <p v-else-if="!pending && !error">{{ t("initial") }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>
