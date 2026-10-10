<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Pencil, Search, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();
const filter = ref("");
const editingName = ref<string | null>(null);
const draft = ref("");
const savingName = ref<string | null>(null);
const saveError = ref<string | null>(null);
const editor = ref<HTMLInputElement | null>(null);

/**
 * Only the probe's `variablesSupported` says the server cannot list variables.
 * `probe.supported === false` means the server cannot be debugged at all, which
 * is a different axis: the session would not even exist. The edit button is
 * disabled by the same flag, so the degraded panel cannot be bypassed.
 */
const variablesUnsupported = computed(() => store.probe?.variablesSupported === false);
const unsupportedReason = computed(() => store.probe?.reason ?? "");
/**
 * Why the panel is degraded, when the agent knows: it reports the DBMS_DEBUG entry
 * points this server does not declare (Oracle 19c/21c lack GET_VALUES, which is the
 * primitive that enumerates variables). `reason` is only set when the *server* cannot
 * be debugged at all, so it is normally empty on this axis — the missing list is what
 * actually explains the panel.
 */
const missingPrimitives = computed(() => (store.probe?.missingOptionalProcedures ?? []).filter((name) => !!name));

const filteredVariables = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return store.variables;
  return store.variables.filter((entry) => entry.name.toLowerCase().includes(needle));
});

async function startEditing(name: string, value: string) {
  editingName.value = name;
  draft.value = value;
  saveError.value = null;
  await nextTick();
  editor.value?.focus();
  editor.value?.select();
}

function cancelEditing() {
  editingName.value = null;
  draft.value = "";
  saveError.value = null;
}

/** DBMS_DEBUG.SET_VALUE: frame 0 is the stopped frame, index 0 the first scalar. */
async function saveValue(name: string) {
  saveError.value = null;
  savingName.value = name;
  try {
    await store.setValue(name, store.currentFrame, 0, draft.value);
    editingName.value = null;
    draft.value = "";
  } catch (caught) {
    saveError.value = String(caught);
  } finally {
    savingName.value = null;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="variablesUnsupported" class="flex items-start gap-1.5 border-b bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {{ t("plDebug.variables.unsupported") }}
        <span v-if="missingPrimitives.length" class="opacity-80">— {{ t("plDebug.variables.unsupportedMissing", { procedures: missingPrimitives.join(", ") }) }}</span>
        <span v-else-if="unsupportedReason" class="opacity-80">— {{ unsupportedReason }}</span>
      </span>
    </div>
    <div class="border-b px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="filter" class="h-7 pl-7 text-xs" :placeholder="t('plDebug.variables.filter')" />
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.name") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.value") }}</th>
            <th class="w-16 px-2 py-1 font-normal">{{ t("plDebug.variables.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in filteredVariables" :key="entry.name" class="border-t">
            <td class="px-2 py-1 align-top font-mono">{{ entry.name }}</td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">
              <template v-if="editingName === entry.name">
                <div class="flex items-center gap-1">
                  <Input ref="editor" v-model="draft" class="h-6 text-xs" :disabled="savingName === entry.name" :placeholder="t('plDebug.variables.valuePlaceholder')" @keydown.enter.prevent="saveValue(entry.name)" @keydown.esc.prevent="cancelEditing" />
                  <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingName === entry.name" :title="t('plDebug.variables.save')" @click="saveValue(entry.name)">
                    <Check class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingName === entry.name" :title="t('plDebug.variables.cancel')" @click="cancelEditing">
                    <X class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </template>
              <template v-else>{{ entry.value }}</template>
            </td>
            <td class="px-2 py-1 align-top">
              <Button v-if="editingName !== entry.name" variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="variablesUnsupported || store.busy || store.terminated" :title="t('plDebug.variables.edit')" @click="startEditing(entry.name, entry.value)">
                <Pencil class="h-3.5 w-3.5" />
              </Button>
            </td>
          </tr>
          <tr v-if="filteredVariables.length === 0">
            <td colspan="3" class="px-2 py-3 text-center text-muted-foreground">
              {{ t("plDebug.variables.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="saveError" class="border-t px-2 py-1 text-xs text-destructive">{{ t("plDebug.variables.setFailed", { error: saveError }) }}</p>
  </div>
</template>
