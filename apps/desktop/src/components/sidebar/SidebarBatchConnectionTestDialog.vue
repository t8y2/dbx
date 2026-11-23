<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { CircleAlert, CircleCheck, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { translateBackendError } from "@/i18n/backend-errors";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{ connectionIds: readonly string[] }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useConnectionStore();

interface TestRow {
  id: string;
  name: string;
  fingerprint?: string;
  status: "pending" | "running" | "success" | "failure" | "skipped";
  error?: string;
}

const rows = ref<TestRow[]>(
  props.connectionIds.map((id) => {
    const config = store.getConfig(id);
    return { id, name: config?.name || id, fingerprint: config ? connectionConfigFingerprint(config) : undefined, status: "pending" };
  }),
);
const running = ref(true);
const stopRequested = ref(false);
const completed = computed(() => rows.value.filter((row) => row.status === "success" || row.status === "failure").length);
let disposed = false;

function currentConfig(row: TestRow) {
  const config = store.getConfig(row.id);
  return config && connectionConfigFingerprint(config) === row.fingerprint ? config : undefined;
}

onMounted(async () => {
  for (const row of rows.value) {
    if (disposed) return;
    const config = currentConfig(row);
    if (stopRequested.value || !config) {
      row.status = "skipped";
      continue;
    }

    row.status = "running";
    try {
      await api.testConnectionWithInfo(config);
      if (disposed) return;
      row.status = currentConfig(row) ? "success" : "skipped";
    } catch (error) {
      if (disposed) return;
      if (currentConfig(row)) {
        row.status = "failure";
        row.error = translateBackendError(t, error);
      } else {
        row.status = "skipped";
      }
    }
  }
  running.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <Dialog
    :open="true"
    @update:open="
      (open) => {
        if (!open && !running) emit('close');
      }
    "
  >
    <DialogContent :show-close-button="!running" class="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t("connection.batchTestTitle") }}</DialogTitle>
        <DialogDescription aria-live="polite">{{ t("connection.batchTestProgress", { completed, total: rows.length }) }}</DialogDescription>
      </DialogHeader>
      <ul class="max-h-[55vh] min-h-0 overflow-y-auto rounded-md border">
        <li v-for="row in rows" :key="row.id" class="grid gap-1 border-b px-3 py-2 last:border-b-0">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <span class="truncate font-medium" :title="row.name">{{ row.name }}</span>
            <span v-if="row.status === 'success'" class="flex shrink-0 items-center gap-1 text-xs"><CircleCheck class="h-4 w-4 text-emerald-600" />{{ t("connection.testSuccess") }}</span>
            <span v-else-if="row.status === 'failure'" class="flex shrink-0 items-center gap-1 text-xs text-destructive"><CircleAlert class="h-4 w-4" />{{ t("connection.batchTestFailed") }}</span>
            <span v-else-if="row.status === 'running'" class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("connection.testing") }}</span>
            <span v-else class="shrink-0 text-xs text-muted-foreground">{{ t(row.status === "skipped" ? "connection.batchTestSkipped" : "connection.batchTestPending") }}</span>
          </div>
          <p v-if="row.error" class="break-words text-xs text-destructive">{{ row.error }}</p>
        </li>
      </ul>
      <DialogFooter>
        <Button v-if="running" variant="outline" :disabled="stopRequested" @click="stopRequested = true">{{ t("connection.batchTestStop") }}</Button>
        <Button v-else @click="emit('close')">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
