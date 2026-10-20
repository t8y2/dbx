<script setup lang="ts">
import { computed, nextTick, ref, toRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, RefreshCw, Code } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useObjectDependencies } from "@/composables/useObjectDependencies";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { objectDependencyNavigation, objectDependencySql, type ObjectDependencyTarget, type ObjectDependencyRow, type ObjectDetailsSection } from "@/lib/database/objectDependencyDetails";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";

const props = defineProps<{ target?: ObjectDependencyTarget; section: ObjectDetailsSection; open?: boolean }>();
const emit = defineEmits<{
  "update:section": [section: ObjectDetailsSection];
  "open-object": [context: ObjectDependencyTarget, target: SqlObjectNavigationTarget];
  "view-sql": [context: ObjectDependencyTarget, sql: string];
}>();
const { t } = useI18n();
const { toast } = useToast();
const id = useId();
const target = computed(() => (props.open === false ? undefined : props.target));
const enabled = computed(() => !!target.value && props.section !== "source");
const { rows, loading, error, loaded, truncated, refresh } = useObjectDependencies(target, enabled);
const sourceVisited = ref(props.section === "source");
watch(toRef(props, "section"), (section) => {
  if (section === "source") sourceVisited.value = true;
});
const sections = ["source", "dependencies", "dependents"] as const;
const directions = ["dependencies", "dependents"] as const;
const hasLinks = computed(() => rows.value.some((row) => !!row.link));
const label = (section: ObjectDetailsSection) => t(section === "source" ? "objects.source" : `objectDependencies.${section}`);
const rowsFor = (section: ObjectDetailsSection) => rows.value.filter((row) => row.direction === (section === "dependencies" ? "DEPENDS_ON" : "REFERENCED_BY"));

async function switchSection(event: KeyboardEvent, current: number) {
  let index: number;
  if (event.key === "ArrowRight") index = (current + 1) % sections.length;
  else if (event.key === "ArrowLeft") index = (current + sections.length - 1) % sections.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = sections.length - 1;
  else return;
  event.preventDefault();
  const parent = (event.currentTarget as HTMLElement).parentElement;
  emit("update:section", sections[index]!);
  await nextTick();
  parent?.querySelector<HTMLButtonElement>(`[data-object-section="${sections[index]}"]`)?.focus();
}

function openObject(row: ObjectDependencyRow) {
  const navigation = objectDependencyNavigation(row);
  if (target.value && navigation) emit("open-object", { ...target.value }, navigation);
}

async function copyName(row: ObjectDependencyRow) {
  try {
    await copyToClipboard(`${row.schema}.${row.name}${row.link ? `@${row.link}` : ""}`);
    toast(t("grid.copied"));
  } catch (e: unknown) {
    toast(t("grid.copyFailed", { message: e instanceof Error ? e.message : String(e) }), 5000);
  }
}
</script>

<template>
  <div v-if="target" class="flex min-h-0 flex-1 flex-col overflow-hidden" data-object-details>
    <div role="tablist" :aria-label="t('contextMenu.viewDependencies')" class="flex shrink-0 gap-1 border-b px-3 pt-1">
      <button
        v-for="(section, index) in sections"
        :id="`${id}-${section}-tab`"
        :key="section"
        type="button"
        role="tab"
        :aria-selected="props.section === section"
        :aria-controls="`${id}-${section}-panel`"
        :tabindex="props.section === section ? 0 : -1"
        :data-object-section="section"
        class="border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="props.section === section ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="emit('update:section', section)"
        @keydown="switchSection($event, index)"
      >
        {{ label(section) }}
      </button>
    </div>
    <div v-if="sourceVisited" v-show="props.section === 'source'" :id="`${id}-source-panel`" role="tabpanel" :aria-labelledby="`${id}-source-tab`" class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <slot />
    </div>
    <section v-for="section in directions" v-show="props.section === section" :id="`${id}-${section}-panel`" :key="section" role="tabpanel" :aria-labelledby="`${id}-${section}-tab`" :aria-busy="loading" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div class="min-w-0">
          <h3 class="text-sm font-medium">
            {{ label(section) }} <span v-if="loaded" class="ml-1 text-muted-foreground">({{ rowsFor(section).length }})</span>
          </h3>
          <p class="mt-1 break-all font-mono text-sm text-muted-foreground">{{ target.schema }}.{{ target.name }}</p>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" :disabled="loading" @click="refresh"><RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" />{{ t("common.refresh") }}</Button>
          <Button variant="ghost" size="sm" @click="emit('view-sql', { ...target }, objectDependencySql(target))"><Code class="h-4 w-4" />{{ t("objectDependencies.viewSql") }}</Button>
        </div>
      </div>
      <div class="shrink-0 space-y-1 px-4 py-2 text-sm text-muted-foreground">
        <p>{{ t("objectDependencies.visibility") }}</p>
        <p v-if="target.objectType === 'PACKAGE'">{{ t("objectDependencies.packageScope") }}</p>
        <p v-if="truncated" class="text-amber-700 dark:text-amber-400">{{ t("objectDependencies.partial") }}</p>
      </div>
      <div v-if="error" role="alert" class="mx-4 mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded border border-destructive/30 px-3 py-2 text-sm">
        <div class="min-w-0 flex-1 whitespace-pre-wrap break-words text-destructive">
          {{ error }}
          <p v-if="loaded" class="mt-1 text-muted-foreground">{{ t("objectDependencies.notUpdated") }}</p>
        </div>
        <Button variant="outline" size="sm" :disabled="loading" @click="refresh">{{ t("common.retry") }}</Button>
      </div>
      <div v-if="loading && !loaded" role="status" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><RefreshCw class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</div>
      <div v-else-if="loaded && !rowsFor(section).length" class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{{ t("objectDependencies.empty") }}</div>
      <div v-else-if="loaded" class="min-h-0 flex-1 overflow-auto border-t">
        <table class="w-full text-left text-sm">
          <thead class="sticky top-0 z-10 bg-muted">
            <tr class="border-b">
              <th class="px-4 py-2 font-medium">{{ t("objects.name") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("objects.type") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("objects.schema") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("objectDependencies.dependencyType") }}</th>
              <th v-if="target.objectType === 'PACKAGE'" class="px-4 py-2 font-medium">{{ t("objectDependencies.sourceType") }}</th>
              <th v-if="hasLinks" class="px-4 py-2 font-medium">{{ t("objectDependencies.link") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rowsFor(section)" :key="index" class="border-b align-top hover:bg-muted/40">
              <td class="px-4 py-2">
                <button v-if="objectDependencyNavigation(row)" type="button" class="break-all text-left font-mono text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openObject(row)">{{ row.name }}</button>
                <template v-else
                  ><div class="flex items-start gap-2">
                    <span class="break-all font-mono">{{ row.name }}</span
                    ><button type="button" class="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('contextMenu.copyName')" @click="copyName(row)"><Copy class="h-3.5 w-3.5" /></button>
                  </div>
                  <p class="mt-1 text-muted-foreground">{{ t(row.link ? "objectDependencies.remoteObject" : "objectDependencies.unsupportedObject") }}</p></template
                >
              </td>
              <td class="whitespace-nowrap px-4 py-2">{{ row.type }}</td>
              <td class="px-4 py-2 font-mono">{{ row.schema }}</td>
              <td class="px-4 py-2">{{ row.dependencyType }}</td>
              <td v-if="target.objectType === 'PACKAGE'" class="whitespace-nowrap px-4 py-2">{{ row.sourceType }}</td>
              <td v-if="hasLinks" class="px-4 py-2 font-mono">{{ row.link }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
  <slot v-else />
</template>
