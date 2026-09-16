<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, RefreshCw, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import type { ConnectionConfig, CustomTypeDetails, CustomTypeKind } from "@/types/database";
import * as api from "@/lib/backend/api";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  schema: string;
  name: string;
  catalog?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const toast = useToast();
const guard = createSidePanelRequestGuard();
const details = ref<CustomTypeDetails | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const tab = ref<"members" | "properties" | "ddl">("members");

const kindLabel = computed(() => (details.value ? t(`customType.kinds.${details.value.kind}`) : ""));
const hasMemberTab = computed(() => details.value?.kind === "composite" || details.value?.kind === "enum");
const tabs = computed(() => {
  const items: Array<{ id: "members" | "properties" | "ddl"; label: string }> = [];
  if (hasMemberTab.value) items.push({ id: "members", label: t("customType.tabs.members") });
  items.push({ id: "properties", label: t("customType.tabs.properties") });
  items.push({ id: "ddl", label: t("customType.tabs.ddl") });
  return items;
});

async function load() {
  // start() bumps the epoch so an in-flight request from a previously selected
  // type can never overwrite the current panel state.
  const epoch = guard.start();
  loading.value = true;
  error.value = null;
  details.value = null;
  tab.value = "members";
  try {
    const result = await api.getCustomTypeDetails(props.connection.id, props.database, props.schema, props.name);
    if (guard.isStale(epoch)) return;
    details.value = result;
    if (tab.value === "members" && result.kind !== "composite" && result.kind !== "enum") {
      tab.value = "properties";
    }
  } catch (e: any) {
    if (guard.isStale(epoch)) return;
    error.value = e?.message || String(e);
  } finally {
    if (guard.isFresh(epoch)) loading.value = false;
  }
}

watch(
  () => [props.connection.id, props.database, props.schema, props.name] as const,
  () => load(),
  { immediate: true },
);

const ddlText = computed(() => details.value?.ddl?.sql ?? "");

async function copyDdl() {
  if (!ddlText.value) return;
  try {
    await copyToClipboard(ddlText.value);
    toast.toast(t("contextMenu.ddlCopied"));
  } catch (error) {
    toast.toast(t("grid.copyFailed", { message: translateBackendError(t, error) }));
  }
}

const propertyRows = computed<Array<{ label: string; value: string }>>(() => {
  const p = details.value?.properties;
  if (!p) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value != null && value !== "") rows.push({ label, value: String(value) });
  };
  push(t("customType.properties.baseType"), p.baseType);
  if (p.notNull) push(t("customType.properties.notNull"), "true");
  push(t("customType.properties.default"), p.default);
  push(t("customType.properties.collation"), p.collation);
  for (const constraint of p.domainConstraints) {
    rows.push({
      label: constraint.name ? `${t("customType.properties.domainConstraint")} · ${constraint.name}` : t("customType.properties.domainConstraint"),
      value: constraint.definition,
    });
  }
  push(t("customType.properties.rangeSubtype"), p.rangeSubtype);
  push(t("customType.properties.rangeMultirange"), p.rangeMultirangeName);
  return rows;
});

function isFieldKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "composite";
}

function isEnumKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "enum";
}

function selectTab(next: "members" | "properties" | "ddl") {
  tab.value = next;
}

defineExpose({ selectTab });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 border-b px-3 py-1.5 bg-muted/20 h-9 shrink-0">
      <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ name }}</span>
      <span class="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">{{ kindLabel }}</span>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('close')">
        <X class="w-3 h-3" />
      </Button>
    </div>

    <div v-if="loading" class="flex-1 flex items-center justify-center text-xs text-muted-foreground">
      {{ t("common.loading") }}
    </div>

    <div v-else-if="error" class="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
      <div class="text-xs text-destructive break-words max-w-full">{{ error }}</div>
      <Button variant="outline" size="sm" class="h-6 text-xs" @click="load">
        <RefreshCw class="w-3 h-3" />
        {{ t("common.retry") }}
      </Button>
    </div>

    <template v-else-if="details">
      <div class="flex items-center gap-1 border-b px-2 py-1 shrink-0">
        <button v-for="item in tabs" :key="item.id" type="button" class="rounded px-2 py-1 text-xs" :class="tab === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="tab = item.id">
          {{ item.label }}
        </button>
        <span class="flex-1" />
        <Button v-if="tab === 'ddl' && ddlText" variant="ghost" size="sm" class="h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyDdl">
          <Copy class="w-3 h-3" />
          <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
        </Button>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Members: empty state for composite/enum -->
        <div v-if="tab === 'members' && details.members.length === 0" class="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <span class="text-xs text-muted-foreground">{{ t("customType.members.empty") }}</span>
        </div>

        <!-- Members: composite fields -->
        <table v-else-if="tab === 'members' && isFieldKind(details.kind)" class="w-full text-[11px]">
          <thead class="sticky top-0 bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th class="px-3 py-1.5 font-medium">#</th>
              <th class="px-3 py-1.5 font-medium">{{ t("customType.members.name") }}</th>
              <th class="px-3 py-1.5 font-medium">{{ t("customType.members.type") }}</th>
              <th class="px-3 py-1.5 font-medium">{{ t("customType.members.nullable") }}</th>
              <th class="px-3 py-1.5 font-medium">{{ t("customType.members.default") }}</th>
              <th class="px-3 py-1.5 font-medium">{{ t("customType.members.comment") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in details.members" :key="member.ordinal" class="border-t border-border/60">
              <td class="px-3 py-1.5 text-muted-foreground">{{ member.ordinal }}</td>
              <td class="px-3 py-1.5 font-mono">{{ member.name }}</td>
              <td class="px-3 py-1.5 font-mono">{{ member.dataType }}</td>
              <td class="px-3 py-1.5">{{ member.nullable == null ? "—" : member.nullable ? "✓" : "✗" }}</td>
              <td class="px-3 py-1.5 font-mono">{{ member.default ?? "—" }}</td>
              <td class="px-3 py-1.5">{{ member.comment ?? "—" }}</td>
            </tr>
          </tbody>
        </table>

        <!-- Members: enum values -->
        <ul v-else-if="tab === 'members' && isEnumKind(details.kind) && details.members.length > 0" class="divide-y divide-border/60">
          <li v-for="member in details.members" :key="member.ordinal" class="flex items-center gap-3 px-3 py-1.5 text-[11px]">
            <span class="w-6 text-muted-foreground text-right">{{ member.ordinal }}</span>
            <span class="font-mono">{{ member.enumValue }}</span>
          </li>
        </ul>

        <!-- Properties -->
        <table v-else-if="tab === 'properties'" class="w-full text-[11px]">
          <tbody>
            <tr v-if="details.comment" class="border-b border-border/60">
              <td class="px-3 py-1.5 text-muted-foreground w-44">{{ t("customType.members.comment") }}</td>
              <td class="px-3 py-1.5">{{ details.comment }}</td>
            </tr>
            <tr v-for="row in propertyRows" :key="row.label" class="border-b border-border/60">
              <td class="px-3 py-1.5 text-muted-foreground w-44 align-top">{{ row.label }}</td>
              <td class="px-3 py-1.5 font-mono whitespace-pre-wrap break-all">{{ row.value }}</td>
            </tr>
            <tr v-if="propertyRows.length === 0 && !details.comment" class="border-b border-border/60">
              <td class="px-3 py-2 text-xs text-muted-foreground" colspan="2">{{ t("customType.properties.empty") }}</td>
            </tr>
          </tbody>
        </table>

        <!-- DDL -->
        <div v-else class="flex h-full flex-col">
          <div v-if="details.ddl && !details.ddl.complete" class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
            <div v-for="warning in details.ddl.warnings" :key="warning" class="text-[11px] text-amber-600 dark:text-amber-400">{{ warning }}</div>
          </div>
          <pre class="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">{{ ddlText || t("customType.ddl.empty") }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>
