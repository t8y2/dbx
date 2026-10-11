<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Check, ChevronDown, ChevronRight, Database, FolderTree, Loader2, Minus, RefreshCcw, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { formatError } from "@/lib/backend/errorUtils";
import { getAdminScopeTree, type AdminScope, type ScopeTreeNode } from "@/lib/admin/adminApi";
import { collectScopeGroupIds, filterScopeTree, flattenScopeTree, scopeNodeStateInTree, toggleScopeNode } from "@/lib/admin/scopeTree";

const props = defineProps<{
  modelValue: AdminScope;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: AdminScope];
}>();

const { t } = useI18n();
const { toast } = useToast();
const nodes = ref<ScopeTreeNode[]>([]);
const ungrouped = ref<ScopeTreeNode[]>([]);
const expandedGroupIds = ref(new Set<string>());
const search = ref("");
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);

const allNodes = computed(() => [...nodes.value, ...ungrouped.value]);
const searchActive = computed(() => search.value.trim().length > 0);
const visibleTree = computed(() => filterScopeTree(nodes.value, search.value));
const visibleRows = computed(() => flattenScopeTree(visibleTree.value, expandedGroupIds.value, searchActive.value));
const visibleUngrouped = computed(() => filterScopeTree(ungrouped.value, search.value));

async function loadTree() {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await getAdminScopeTree();
    nodes.value = result.nodes;
    ungrouped.value = result.ungrouped;
    expandedGroupIds.value = new Set(collectScopeGroupIds(result.nodes));
    loaded.value = true;
  } catch (error) {
    loadError.value = t("accessControl.errors.loadFailed", { message: formatError(error) });
    toast(loadError.value, 5000);
  } finally {
    loading.value = false;
  }
}

function state(node: ScopeTreeNode) {
  return scopeNodeStateInTree(allNodes.value, props.modelValue, node.type, node.id);
}

function toggleNode(node: ScopeTreeNode) {
  emit("update:modelValue", toggleScopeNode(allNodes.value, props.modelValue, node.type, node.id));
}

function toggleExpanded(groupId: string) {
  const next = new Set(expandedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroupIds.value = next;
}

onMounted(loadTree);
</script>

<template>
  <section class="overflow-hidden rounded-lg border bg-background">
    <header class="flex items-center gap-3 border-b bg-muted/25 p-3">
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold">{{ t("accessControl.scope.title") }}</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t("accessControl.scope.hint") }}</p>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" :aria-label="t('accessControl.refresh')" :disabled="loading" @click="loadTree">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCcw v-else class="h-3.5 w-3.5" />
      </Button>
    </header>

    <div class="border-b p-2">
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" class="h-8 pl-8 text-xs" :placeholder="t('accessControl.scope.search')" />
      </div>
    </div>

    <div class="max-h-72 overflow-auto p-1.5">
      <div v-if="loading && !loaded" class="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 class="h-4 w-4 animate-spin" />
        {{ t("accessControl.loading") }}
      </div>
      <div v-else-if="loadError && !loaded" class="flex flex-col items-center gap-3 px-4 py-8 text-center" role="alert">
        <AlertCircle class="h-5 w-5 text-destructive" />
        <p class="max-w-sm text-xs text-destructive">{{ loadError }}</p>
        <Button type="button" variant="outline" size="sm" :disabled="loading" @click="loadTree">
          <RefreshCcw class="mr-1.5 h-3.5 w-3.5" />
          {{ t("accessControl.refresh") }}
        </Button>
      </div>
      <template v-else>
        <div v-if="loadError" class="mb-1.5 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          <AlertCircle class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1">{{ loadError }}</span>
        </div>
        <div v-if="visibleRows.length === 0 && visibleUngrouped.length === 0" class="py-10 text-center text-xs text-muted-foreground">
          {{ t(searchActive ? "accessControl.scope.noMatches" : "accessControl.scope.empty") }}
        </div>
        <template v-else>
          <div v-for="row in visibleRows" :key="`${row.node.type}:${row.node.id}`" class="group flex h-8 items-center rounded-md pr-2 text-xs hover:bg-accent/70" :style="{ paddingLeft: `${row.depth * 16 + 4}px` }">
            <button
              v-if="row.node.type === 'group'"
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              :aria-label="t(expandedGroupIds.has(row.node.id) ? 'accessControl.scope.collapse' : 'accessControl.scope.expand', { name: row.node.name })"
              @click="toggleExpanded(row.node.id)"
            >
              <ChevronDown v-if="searchActive || expandedGroupIds.has(row.node.id)" class="h-3.5 w-3.5" />
              <ChevronRight v-else class="h-3.5 w-3.5" />
            </button>
            <span v-else class="w-7 shrink-0" />
            <button
              type="button"
              role="checkbox"
              :aria-checked="state(row.node) === 'indeterminate' ? 'mixed' : state(row.node) === 'checked'"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
              :class="state(row.node) === 'unchecked' ? 'border-border bg-background' : 'border-primary bg-primary text-primary-foreground'"
              @click="toggleNode(row.node)"
            >
              <Minus v-if="state(row.node) === 'indeterminate'" class="h-3 w-3" />
              <Check v-else-if="state(row.node) === 'checked'" class="h-3 w-3" />
            </button>
            <button type="button" class="ml-2 flex min-w-0 flex-1 items-center gap-2 text-left" @click="toggleNode(row.node)">
              <FolderTree v-if="row.node.type === 'group'" class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <Database v-else class="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
              <span class="truncate">{{ row.node.name }}</span>
            </button>
          </div>

          <div v-if="visibleUngrouped.length > 0" class="mt-2 border-t pt-2">
            <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{{ t("accessControl.scope.ungrouped") }}</div>
            <div v-for="node in visibleUngrouped" :key="`ungrouped:${node.id}`" class="flex h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-accent/70">
              <button
                type="button"
                role="checkbox"
                :aria-checked="state(node) === 'checked'"
                class="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
                :class="state(node) === 'checked' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'"
                @click="toggleNode(node)"
              >
                <Check v-if="state(node) === 'checked'" class="h-3 w-3" />
              </button>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="toggleNode(node)">
                <Database class="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                <span class="truncate">{{ node.name }}</span>
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>
