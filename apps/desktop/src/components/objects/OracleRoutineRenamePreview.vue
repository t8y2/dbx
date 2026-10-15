<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { OracleRoutineRenamePlan } from "@/lib/table/oracleRoutineRename";

const props = defineProps<{ plan: OracleRoutineRenamePlan | null; drafts: Record<string, string>; loading: boolean; validating: boolean; executing: boolean }>();
const emit = defineEmits<{ edit: [key: string, source: string]; validate: []; reload: [] }>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.validating || props.executing);
const entries = computed(() => {
  const plan = props.plan;
  if (!plan) return [];
  const root = plan.root ? [{ key: `${plan.root.objectType}:${plan.root.name}`, name: plan.root.name, objectType: plan.root.objectType, source: plan.root.source, draft: plan.rootDraft, generated: plan.rootCreateSource, rewriteRequired: true }] : [];
  return [
    ...root,
    ...plan.callers.map((caller) => ({ key: `${caller.objectType}:${caller.name}`, name: caller.name, objectType: caller.objectType, source: caller.source, draft: caller.draft, generated: caller.rewriteRequired ? caller.rewrittenSource : "", rewriteRequired: caller.rewriteRequired })),
  ];
});
const assignedIssues = computed(() => new Set(entries.value.map((entry) => entry.name)));
const statementsCurrent = computed(() => !!props.plan && entries.value.every((entry) => isCurrentDraft(entry.key, entry.draft)));
function isCurrentDraft(key: string, validatedDraft: string) {
  return (props.drafts[key] ?? validatedDraft) === validatedDraft;
}
function edit(key: string, event: Event) {
  emit("edit", key, (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <section class="space-y-3 text-sm" :aria-busy="busy">
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("objects.routineRenameCoverage") }}</p>
    <p v-if="loading || validating" role="status" class="text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="!plan?.executable" role="status" class="text-destructive">{{ t("objects.viewRenameValidationPending") }}</p>
    <div v-if="plan?.root" class="rounded border border-border p-3">
      <p class="mb-2 font-medium">{{ t("objects.routineRenameObjects") }}</p>
      <ul class="space-y-1 text-xs text-muted-foreground">
        <li>{{ plan.target.objectType }} · {{ plan.target.schema }}.{{ plan.target.oldName }} → {{ plan.target.schema }}.{{ plan.canonicalNewName }}</li>
        <li v-for="caller in plan.callers" :key="`${caller.objectType}:${caller.name}`">{{ caller.objectType }} · {{ plan.target.schema }}.{{ caller.name }} · {{ t(caller.rewriteRequired ? "objects.routineRenameRewrite" : "objects.routineRenameCompile") }}</li>
      </ul>
    </div>
    <ul v-if="plan?.issues.some((issue) => !issue.objectName || !assignedIssues.has(issue.objectName))" class="space-y-2" aria-live="polite">
      <li v-for="(issue, index) in plan.issues.filter((item) => !item.objectName || !assignedIssues.has(item.objectName))" :key="index" class="rounded border border-destructive/40 p-2">
        <p class="font-medium text-destructive">{{ issue.objectName || plan.target.oldName }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
        <p v-if="!issue.repairable" class="text-xs text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
        <details class="mt-1 text-xs text-muted-foreground" data-diagnostics>
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
        </details>
      </li>
    </ul>
    <details v-for="entry in entries" :key="entry.key" :open="plan?.issues.some((issue) => issue.objectName === entry.name)" class="rounded border border-border" :data-source-name="entry.key">
      <summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span class="min-w-0 break-all font-medium">{{ entry.objectType }} · {{ entry.name }}</span>
        <span class="shrink-0 rounded bg-muted px-2 py-0.5 text-xs" :class="plan?.issues.some((issue) => issue.objectName === entry.name) ? 'text-destructive' : 'text-muted-foreground'">
          {{ t(plan?.issues.some((issue) => issue.objectName === entry.name) ? "objects.viewRenameNeedsRepair" : "objects.viewRenameDefinitionReady") }}
        </span>
      </summary>
      <div class="space-y-3 border-t border-border p-3">
        <ul v-if="plan?.issues.some((issue) => issue.objectName === entry.name)" class="space-y-2" aria-live="polite">
          <li v-for="(issue, index) in plan.issues.filter((item) => item.objectName === entry.name)" :key="index" class="space-y-1">
            <p class="font-medium text-destructive">{{ entry.name }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
            <p v-if="!issue.repairable" class="text-xs text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
            <details class="text-xs text-muted-foreground" data-diagnostics>
              <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
            </details>
          </li>
        </ul>
        <label v-if="entry.rewriteRequired" class="block space-y-1">
          <span class="block text-xs text-muted-foreground">{{ t("objects.viewRenameDraft") }} · {{ plan?.target.schema }}.{{ entry.name }}</span>
          <textarea
            :value="drafts[entry.key] ?? entry.draft"
            :disabled="busy || !entry.source.trim()"
            spellcheck="false"
            rows="10"
            class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            :data-source-draft="entry.key"
            @input="edit(entry.key, $event)"
          />
        </label>
        <div v-if="entry.generated && isCurrentDraft(entry.key, entry.draft)" class="space-y-1">
          <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }}</p>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ entry.generated }}</pre>
        </div>
      </div>
    </details>
    <details v-if="statementsCurrent && plan?.statements.length" class="rounded border border-border" open>
      <summary class="cursor-pointer px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("objects.viewRenameFinalSql") }}</summary>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3 font-mono text-xs">{{ plan.statements.join("\n\n") }}</pre>
    </details>
    <div class="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" :disabled="busy || !plan" data-validate @click="emit('validate')">{{ t("objects.viewRenameValidate") }}</Button>
      <Button type="button" variant="outline" size="sm" :disabled="busy" data-reload @click="emit('reload')">{{ t("objects.viewRenameReload") }}</Button>
    </div>
  </section>
</template>
