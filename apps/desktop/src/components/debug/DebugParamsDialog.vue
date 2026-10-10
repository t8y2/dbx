<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePlDebugStore } from "@/stores/plDebugStore";
import type { PlDebugParam, PlDebugStartRequest } from "@/lib/backend/pl-debug-tauri";

const { t } = useI18n();
const store = usePlDebugStore();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  objectType: string;
  objectName?: string;
  packageName?: string;
  source?: string;
  schema?: string;
  /** Routine parameters as parsed from the object source by the caller. */
  params: PlDebugParam[];
  /** True while the caller is still resolving `params` from database metadata. */
  loading?: boolean;
  /** Metadata lookup failure, reported instead of the empty-parameter hint. */
  loadError?: string | null;
  database: string;
  connectionId: string;
}>();

const emit = defineEmits<{ started: [debugId: string] }>();

const editableParams = ref<PlDebugParam[]>([]);
const starting = ref(false);
const errorMessage = ref<string | null>(null);

// Seed the editable rows on open and whenever the caller publishes parameters
// afterwards: the launch dialog resolves them with a metadata query, so they can
// arrive after the dialog is already visible.
watch(
  () => [open.value, props.params] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    editableParams.value = props.params.map((param) => ({ ...param }));
    errorMessage.value = null;
  },
  { immediate: true },
);

const title = computed(() => {
  const target = props.packageName ? `${props.packageName}.${props.objectName}` : (props.objectName ?? "");
  return `${t("plDebug.start.title")} — ${target}`;
});

async function startDebug() {
  starting.value = true;
  errorMessage.value = null;
  try {
    const request: PlDebugStartRequest = {
      schema: props.schema ?? null,
      objectType: props.objectType,
      objectName: props.objectName ?? null,
      packageName: props.packageName ?? null,
      source: props.source ?? null,
      params: editableParams.value,
    };
    const result = await store.start(props.connectionId, props.database, request);
    open.value = false;
    emit("started", result.debugId ?? "");
  } catch (caught) {
    errorMessage.value = String(caught);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>
      <div class="max-h-80 overflow-auto">
        <table class="w-full text-xs">
          <thead class="text-left text-muted-foreground">
            <tr>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.params.name") }}</th>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.params.mode") }}</th>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.params.type") }}</th>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.params.value") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(param, index) in editableParams" :key="`${param.name}-${index}`" class="border-t">
              <td class="px-2 py-1 font-mono">{{ param.name }}</td>
              <td class="px-2 py-1">{{ param.mode }}</td>
              <td class="px-2 py-1 font-mono">{{ param.type }}</td>
              <td class="px-2 py-1">
                <Input v-if="!param.mode.toUpperCase().startsWith('OUT')" :model-value="param.value ?? ''" class="h-7 font-mono text-xs" :placeholder="t('plDebug.params.valuePlaceholder')" @update:model-value="param.value = String($event)" />
                <span v-else class="text-muted-foreground">—</span>
              </td>
            </tr>
            <tr v-if="loading && editableParams.length === 0">
              <td colspan="4" class="px-2 py-3 text-center text-muted-foreground"><Loader2 class="mr-1 inline h-3 w-3 animate-spin" />{{ t("plDebug.launch.loading") }}</td>
            </tr>
            <tr v-else-if="editableParams.length === 0">
              <td colspan="4" class="px-2 py-3 text-center text-muted-foreground">{{ t("plDebug.params.empty") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="loadError" class="text-xs text-destructive">{{ loadError }}</p>
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="starting" @click="open = false">
          {{ t("common.cancel") }}
        </Button>
        <Button :disabled="starting" @click="startDebug">
          <Loader2 v-if="starting" class="mr-1 h-4 w-4 animate-spin" />
          {{ t("plDebug.start.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
