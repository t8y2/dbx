<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ArrowRight, Wand2 } from "@lucide/vue";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { getDataTypeOptions } from "@/lib/table/tableStructureEditorState";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { findPreset } from "@/lib/fieldMappingPresets";
import type { FieldMappingEntry, FieldMappingParamStrategy } from "@/types/schemaDiff";
import type { DatabaseType } from "@/types/database";

const { t } = useI18n();
const store = useConnectionStore();

const props = defineProps<{
  mappings: FieldMappingEntry[];
  sourceDbType: string;
  targetDbType: string;
  /** Same source as table structure editor: live types via listDataTypes(connection, database). */
  sourceConnectionId?: string;
  sourceDatabase?: string;
  targetConnectionId?: string;
  targetDatabase?: string;
}>();

const emit = defineEmits<{
  (e: "update:mappings", value: FieldMappingEntry[]): void;
}>();

const sameType = computed(() => props.sourceDbType === props.targetDbType);

const sourceTypeOptions = ref<string[]>([]);
const targetTypeOptions = ref<string[]>([]);
const selectedPresetId = ref<string>("");

const availablePresets = computed(() => {
  const preset = findPreset(props.sourceDbType, props.targetDbType);
  return preset ? [preset] : [];
});

/** Same merge semantics as TableStructureEditor (local copy; do not touch structure editor code). */
function mergeDataTypeOptions(primary: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of [...primary, ...fallback]) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** Match TableStructureEditor: listDataTypes(connection, database) + getDataTypeOptions(dbType). */
async function loadTypeOptions(dbType: string, connectionId?: string, database?: string): Promise<string[]> {
  const fallback = getDataTypeOptions((dbType || undefined) as DatabaseType | undefined);
  if (!connectionId || !database) {
    return fallback;
  }
  try {
    await store.ensureConnected(connectionId);
    const live = await api.listDataTypes(connectionId, database);
    return mergeDataTypeOptions(live, fallback);
  } catch {
    return fallback;
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? prev[j - 1] : Math.min(prev[j], curr[j - 1], prev[j - 1]) + 1;
    }
    prev = curr;
  }
  return prev[n];
}

function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function autoGenerateMappings() {
  const srcTypes = sourceTypeOptions.value;
  const tgtTypes = targetTypeOptions.value;
  if (srcTypes.length === 0 || tgtTypes.length === 0) return;

  const used = new Set<string>();
  const result: FieldMappingEntry[] = [];

  for (const src of srcTypes) {
    let bestTarget = "";
    let bestSim = 0;
    for (const tgt of tgtTypes) {
      if (used.has(tgt)) continue;
      const sim = nameSimilarity(src, tgt);
      if (sim > bestSim) {
        bestSim = sim;
        bestTarget = tgt;
      }
    }
    if (bestTarget && bestSim >= 0.3) {
      result.push({ sourceType: src, targetType: bestTarget, paramStrategy: "preserve" });
      used.add(bestTarget);
    }
  }

  if (result.length > 0) {
    emit("update:mappings", result);
  }
}

async function loadSourceTypes() {
  sourceTypeOptions.value = await loadTypeOptions(props.sourceDbType, props.sourceConnectionId, props.sourceDatabase);
}

async function loadTargetTypes() {
  targetTypeOptions.value = await loadTypeOptions(props.targetDbType, props.targetConnectionId, props.targetDatabase);
}

function addMapping() {
  emit("update:mappings", [...props.mappings, { sourceType: "", targetType: "", paramStrategy: "preserve" as FieldMappingParamStrategy }]);
}

function removeMapping(index: number) {
  const next = props.mappings.filter((_, i) => i !== index);
  emit("update:mappings", next);
}

function updateMapping(index: number, field: keyof FieldMappingEntry, value: any) {
  const next = props.mappings.map((m, i) => (i === index ? { ...m, [field]: value } : m));
  emit("update:mappings", next);
}

function applyPreset(presetId: string) {
  selectedPresetId.value = presetId;
  const preset = findPreset(props.sourceDbType, props.targetDbType);
  if (preset) {
    emit("update:mappings", [...preset.mappings]);
  }
}

watch(
  () => [props.sourceDbType, props.sourceConnectionId, props.sourceDatabase] as const,
  () => {
    void loadSourceTypes();
  },
);
watch(
  () => [props.targetDbType, props.targetConnectionId, props.targetDatabase] as const,
  () => {
    void loadTargetTypes();
  },
);

// Auto-generate mappings when both type lists are ready, no preset exists, and no mappings yet
watch([sourceTypeOptions, targetTypeOptions, availablePresets], ([src, tgt, presets]) => {
  if (src.length > 0 && tgt.length > 0 && props.mappings.length === 0 && presets.length === 0 && !sameType.value) {
    autoGenerateMappings();
  }
});

onMounted(() => {
  void loadSourceTypes();
  void loadTargetTypes();
});
</script>

<template>
  <div class="border rounded-lg bg-card">
    <div class="flex items-center gap-2 px-3 py-2 border-b">
      <span class="text-xs font-medium">{{ t("diff.fieldMapping.title") }}</span>
      <span v-if="!sameType" class="flex items-center gap-1 ml-1">
        <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{{ sourceDbType }}</span>
        <ArrowRight class="w-3 h-3 text-muted-foreground" />
        <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">{{ targetDbType }}</span>
      </span>
    </div>

    <div v-if="sameType" class="px-3 py-4 text-xs text-muted-foreground text-center">
      {{ t("diff.fieldMapping.sameTypeHint") }}
    </div>

    <div v-else class="p-3 max-h-[42vh] overflow-auto">
      <div v-if="availablePresets.length > 0" class="mb-3">
        <label class="text-[10px] font-medium text-muted-foreground mb-1 block">
          {{ t("diff.fieldMapping.preset") }}
        </label>
        <Select :model-value="selectedPresetId" @update:model-value="(v: any) => applyPreset(v)">
          <SelectTrigger class="h-8 w-full text-xs">
            <SelectValue :placeholder="t('diff.fieldMapping.selectPreset')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in availablePresets" :key="p.id" :value="p.id">{{ p.label }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div v-if="mappings.length === 0" class="flex flex-col items-center justify-center py-6 gap-3">
        <p class="text-xs text-muted-foreground">{{ t("diff.fieldMapping.noMappings") }}</p>
        <Button v-if="availablePresets.length === 0" variant="outline" size="sm" class="h-7 text-xs gap-1" @click="autoGenerateMappings" :disabled="sameType || sourceTypeOptions.length === 0 || targetTypeOptions.length === 0">
          <Wand2 class="w-3.5 h-3.5" />
          {{ t("diff.fieldMapping.autoGenerate") }}
        </Button>
      </div>

      <div v-else class="space-y-3">
        <div class="grid grid-cols-[1fr_auto_1fr_100px_auto] gap-2 items-center px-1">
          <span class="text-[10px] font-medium text-muted-foreground">{{ t("diff.fieldMapping.sourceType") }}</span>
          <div />
          <span class="text-[10px] font-medium text-muted-foreground">{{ t("diff.fieldMapping.targetType") }}</span>
          <span class="text-[10px] font-medium text-muted-foreground">{{ t("diff.fieldMapping.paramStrategy") }}</span>
          <div />
        </div>
        <div v-for="(mapping, i) in mappings" :key="i" class="space-y-1">
          <div class="grid grid-cols-[1fr_auto_1fr_100px_auto] gap-2 items-center">
            <SearchableSelect
              :model-value="mapping.sourceType"
              @update:model-value="(v: string) => updateMapping(i, 'sourceType', v)"
              :options="sourceTypeOptions"
              :placeholder="t('diff.fieldMapping.sourceType')"
              :search-placeholder="t('diff.fieldMapping.sourceType')"
              :empty-text="t('common.noResults')"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs font-mono"
              content-class="w-[var(--reka-popover-trigger-width)]"
              allow-custom
            />
            <ArrowRight class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <SearchableSelect
              :model-value="mapping.targetType"
              @update:model-value="(v: string) => updateMapping(i, 'targetType', v)"
              :options="targetTypeOptions"
              :placeholder="t('diff.fieldMapping.targetType')"
              :search-placeholder="t('diff.fieldMapping.targetType')"
              :empty-text="t('common.noResults')"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs font-mono"
              content-class="w-[var(--reka-popover-trigger-width)]"
              allow-custom
            />
            <Select :model-value="mapping.paramStrategy" @update:model-value="(v: any) => updateMapping(i, 'paramStrategy', v)">
              <SelectTrigger class="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="preserve">{{ t("diff.fieldMapping.strategyPreserve") }}</SelectItem>
                <SelectItem value="strip">{{ t("diff.fieldMapping.strategyStrip") }}</SelectItem>
                <SelectItem value="custom">{{ t("diff.fieldMapping.strategyCustom") }}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon-sm" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" @click="removeMapping(i)">
              <Trash2 class="w-3.5 h-3.5" />
            </Button>
          </div>
          <div v-if="mapping.paramStrategy === 'custom'" class="flex items-center gap-2 pl-1">
            <input
              :value="mapping.customParams || ''"
              @input="(e: any) => updateMapping(i, 'customParams', (e.target as HTMLInputElement).value)"
              class="h-7 w-32 rounded border border-input bg-background px-2 text-xs font-mono outline-none focus:ring-1 focus:ring-ring"
              :placeholder="t('diff.fieldMapping.customParamsPlaceholder')"
            />
          </div>
        </div>
      </div>

      <div class="mt-3">
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="addMapping">
          <Plus class="w-3.5 h-3.5" />
          {{ t("diff.fieldMapping.addMapping") }}
        </Button>
      </div>
    </div>
  </div>
</template>
