<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { useQueryStore } from "@/stores/queryStore";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import { plDebugRecoveryConnectionId } from "./plDebugLaunch";

const { t } = useI18n();
const store = usePlDebugStore();
const queryStore = useQueryStore();
const sessions = ref<PlDebugSnapshot[]>([]);
const selectedId = ref("");
const loading = ref(false);
const restoring = ref(false);
const error = ref("");
let serial = 0;
const selected = computed(() => sessions.value.find((session) => session.sessionId === selectedId.value));
function label(session: PlDebugSnapshot) {
  return [session.target.schema, session.target.packageName, session.target.objectName].filter(Boolean).join(".") || t("plDebug.launch.anonymousTitle");
}
function close() {
  serial += 1;
  store.cancelSessionDiscovery();
  plDebugRecoveryConnectionId.value = null;
}
async function refresh() {
  const connectionId = plDebugRecoveryConnectionId.value;
  if (!connectionId) return;
  const token = ++serial;
  loading.value = true;
  error.value = "";
  selectedId.value = "";
  sessions.value = [];
  try {
    const found = await store.discoverSessions(connectionId);
    if (token === serial) sessions.value = found;
  } catch (caught) {
    if (token === serial) error.value = String(caught);
  } finally {
    if (token === serial) loading.value = false;
  }
}
async function restore() {
  const session = selected.value;
  if (!session || restoring.value) return;
  const token = serial;
  restoring.value = true;
  try {
    await store.adoptDiscoveredSession(session.sessionId);
  } catch (caught) {
    if (token === serial) error.value = String(caught);
  } finally {
    if (token === serial) {
      restoring.value = false;
      const current = store.sessionRef;
      if (current?.sessionId === session.sessionId && current.connectionId === session.connectionId && current.clientSessionId === session.clientSessionId) {
        queryStore.openPlDebugTab({ connectionId: session.connectionId, database: session.database, schema: typeof session.target.schema === "string" ? session.target.schema : undefined, title: label(session) });
        close();
      }
    }
  }
}
watch(plDebugRecoveryConnectionId, () => void refresh(), { immediate: true });
onScopeDispose(() => {
  serial += 1;
  store.cancelSessionDiscovery();
});
</script>

<template>
  <Dialog
    :open="!!plDebugRecoveryConnectionId"
    @update:open="
      (open) => {
        if (!open) close();
      }
    "
  >
    <DialogContent class="sm:max-w-xl">
      <DialogHeader
        ><DialogTitle>{{ t("plDebug.recovery.title") }}</DialogTitle></DialogHeader
      >
      <p v-if="loading" role="status">{{ t("common.loading") }}</p>
      <p v-else-if="error" role="alert" class="break-words text-sm text-destructive">{{ error }}</p>
      <p v-else-if="!sessions.length" role="status" class="text-sm text-muted-foreground">{{ t("plDebug.recovery.empty") }}</p>
      <fieldset v-else class="max-h-80 space-y-2 overflow-auto" :disabled="restoring">
        <legend class="sr-only">{{ t("plDebug.recovery.choose") }}</legend>
        <label v-for="session in sessions" :key="session.sessionId" class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary">
          <input v-model="selectedId" type="radio" name="pl-debug-recovery" :value="session.sessionId" class="mt-1" />
          <span class="min-w-0 space-y-1"
            ><span class="block break-all font-mono text-sm">{{ label(session) }}</span
            ><span class="block text-sm text-muted-foreground"
              >{{ session.database }} · {{ t(`plDebug.state.${session.executionStopped ? "finished" : session.state === "paused" ? "paused" : session.state === "running" ? "running" : "unknown"}`) }} · {{ t(`plDebug.recovery.release.${session.releaseState}`) }}</span
            ></span
          >
        </label>
      </fieldset>
      <p v-if="selected && selected.recovery?.version !== 1" class="text-sm text-muted-foreground">{{ t("plDebug.recovery.legacyReadOnly") }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="loading || restoring" @click="refresh">{{ t("common.refresh") }}</Button>
        <Button variant="outline" @click="close">{{ t("common.cancel") }}</Button>
        <Button :disabled="!selected || loading || restoring" @click="restore">{{ t("plDebug.recovery.restore") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
