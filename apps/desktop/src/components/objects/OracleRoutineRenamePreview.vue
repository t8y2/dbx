<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SourceMigrationPreview from "@/components/objects/SourceMigrationPreview.vue";
import type { OracleRoutineRenamePlan } from "@/lib/table/oracleRoutineRename";

const props = defineProps<{ plan: OracleRoutineRenamePlan | null; drafts: Record<string, string>; loading: boolean; validating: boolean; executing: boolean }>();
const emit = defineEmits<{ edit: [key: string, source: string]; validate: []; reload: [] }>();
const { t } = useI18n();
const entries = computed(() => {
  const plan = props.plan;
  if (!plan) return [];
  const root = plan.root ? [{ key: `${plan.root.objectType}:${plan.root.name}`, name: plan.root.name, objectType: plan.root.objectType, source: plan.root.source, draft: plan.rootDraft, generated: plan.rootCreateSource, rewriteRequired: true }] : [];
  return [
    ...root,
    ...plan.callers.map((caller) => ({ key: `${caller.objectType}:${caller.name}`, name: caller.name, objectType: caller.objectType, source: caller.source, draft: caller.draft, generated: caller.rewriteRequired ? caller.rewrittenSource : "", rewriteRequired: caller.rewriteRequired })),
  ].map((entry) => ({ ...entry, owner: plan.target.schema, editable: !!entry.source.trim() }));
});
const issues = computed(() => (props.plan?.issues ?? []).map((issue) => ({ ...issue, objectKey: entries.value.find((entry) => entry.name === issue.objectName)?.key, label: issue.objectName || props.plan?.target.oldName })));
</script>

<template>
  <SourceMigrationPreview
    :entries="entries"
    :issues="issues"
    :drafts="drafts"
    :statements="plan?.statements ?? []"
    :loading="loading"
    :validating="validating"
    :executing="executing"
    :executable="!!plan?.executable"
    :ready="!!plan"
    @edit="(key, source) => emit('edit', key, source)"
    @validate="emit('validate')"
    @reload="emit('reload')"
  >
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("objects.routineRenameCoverage") }}</p>
    <div v-if="plan?.root" class="rounded border border-border p-3">
      <p class="mb-2 font-medium">{{ t("objects.routineRenameObjects") }}</p>
      <ul class="space-y-1 text-xs text-muted-foreground">
        <li>{{ plan.target.objectType }} · {{ plan.target.schema }}.{{ plan.target.oldName }} → {{ plan.target.schema }}.{{ plan.canonicalNewName }}</li>
        <li v-for="caller in plan.callers" :key="`${caller.objectType}:${caller.name}`">{{ caller.objectType }} · {{ plan.target.schema }}.{{ caller.name }} · {{ t(caller.rewriteRequired ? "objects.routineRenameRewrite" : "objects.routineRenameCompile") }}</li>
      </ul>
    </div>
  </SourceMigrationPreview>
</template>
