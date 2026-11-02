<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckSquare, Square, ChevronDown, Search, Database, Layers, Loader2, X } from "@lucide/vue";

const props = withDefaults(
  defineProps<{
    schemas: string[];
    selectedSchemas: string[];
    loading?: boolean;
    disabled?: boolean;
  }>(),
  {
    loading: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: "update:selectedSchemas", value: string[]): void;
}>();

const { t } = useI18n();
const open = ref(false);
const searchQuery = ref("");

const selectedSet = computed(() => new Set(props.selectedSchemas));

const isAllSelected = computed(() => props.schemas.length > 0 && props.schemas.every((s) => selectedSet.value.has(s)));

const filteredSchemas = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return props.schemas;
  return props.schemas.filter((s) => s.toLowerCase().includes(q));
});

const triggerLabel = computed(() => {
  if (props.loading) return t("common.loading");
  if (props.schemas.length === 0) return t("diagram.selectSchema");
  if (isAllSelected.value) return t("diagram.allSchemas");
  if (props.selectedSchemas.length === 1) return props.selectedSchemas[0];
  if (props.selectedSchemas.length > 1) {
    return t("diagram.selectedSchemasCount", { count: props.selectedSchemas.length });
  }
  return t("diagram.selectSchema");
});

function toggleSchema(name: string) {
  if (selectedSet.value.has(name)) {
    emit(
      "update:selectedSchemas",
      props.selectedSchemas.filter((s) => s !== name),
    );
  } else {
    emit("update:selectedSchemas", [...props.selectedSchemas, name]);
  }
}

function selectOnly(name: string, event: MouseEvent) {
  event.stopPropagation();
  emit("update:selectedSchemas", [name]);
}

function toggleAll() {
  if (isAllSelected.value) {
    emit("update:selectedSchemas", []);
  } else {
    emit("update:selectedSchemas", [...props.schemas]);
  }
}

function clearAll() {
  emit("update:selectedSchemas", []);
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" role="combobox" :aria-expanded="open" :disabled="disabled || !schemas.length || loading" class="h-8 min-w-36 max-w-56 justify-between gap-1.5 px-2.5 text-xs font-normal" :title="triggerLabel">
        <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          <Database v-else-if="isAllSelected" class="h-3.5 w-3.5 shrink-0 text-primary" />
          <Layers v-else-if="selectedSchemas.length > 1" class="h-3.5 w-3.5 shrink-0 text-primary" />
          <Layers v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ triggerLabel }}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <Badge v-if="isAllSelected" variant="secondary" class="h-4 px-1 text-[10px] font-normal">
            {{ schemas.length }}
          </Badge>
          <Badge v-else-if="selectedSchemas.length > 1" variant="secondary" class="h-4 px-1 text-[10px] font-normal">
            {{ selectedSchemas.length }}
          </Badge>
          <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-50" />
        </div>
      </Button>
    </PopoverTrigger>

    <PopoverContent class="w-64 p-2 text-xs" align="start">
      <!-- Quick actions -->
      <div class="flex items-center justify-between gap-2 border-b pb-2 mb-2">
        <button type="button" class="flex items-center gap-1.5 text-left font-medium text-xs hover:text-primary transition-colors" @click="toggleAll">
          <CheckSquare v-if="isAllSelected" class="h-3.5 w-3.5 text-primary" />
          <Square v-else class="h-3.5 w-3.5 text-muted-foreground" />
          <span>{{ t("diagram.allSchemas") }}</span>
        </button>
        <button v-if="selectedSchemas.length > 0" type="button" class="text-[11px] text-muted-foreground hover:text-foreground transition-colors" @click="clearAll">
          {{ t("diagram.deselectAllSchemas") }}
        </button>
      </div>

      <!-- Search box when schemas > 5 -->
      <div v-if="schemas.length > 5" class="relative mb-2">
        <Search class="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="searchQuery" class="h-7 pl-6 pr-6 text-xs" :placeholder="t('diagram.searchSchemas')" />
        <button v-if="searchQuery" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchQuery = ''">
          <X class="h-3 w-3" />
        </button>
      </div>

      <!-- Schemas List -->
      <div class="max-h-52 overflow-y-auto space-y-0.5">
        <div v-for="name in filteredSchemas" :key="name" class="group flex items-center justify-between rounded px-2 py-1.5 hover:bg-accent cursor-pointer transition-colors" @click="toggleSchema(name)">
          <div class="flex min-w-0 items-center gap-2">
            <CheckSquare v-if="selectedSet.has(name)" class="h-3.5 w-3.5 shrink-0 text-primary" />
            <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate font-mono text-[11px]" :title="name">{{ name }}</span>
          </div>

          <button type="button" class="opacity-0 group-hover:opacity-100 text-[10px] text-primary/80 hover:text-primary px-1 py-0.5 rounded hover:bg-primary/10 transition-opacity" :title="t('diagram.onlyThisSchema')" @click="selectOnly(name, $event)">
            {{ t("diagram.onlyThisSchema") }}
          </button>
        </div>

        <div v-if="filteredSchemas.length === 0" class="py-3 text-center text-muted-foreground text-[11px]">
          {{ t("common.noMatches") || "No matches" }}
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
