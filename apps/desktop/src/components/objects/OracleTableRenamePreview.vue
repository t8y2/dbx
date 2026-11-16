<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { OracleTableRenamePlan } from "@/lib/table/oracleTableRename";

const props = defineProps<{ plan: OracleTableRenamePlan | null; drafts: Record<string, string>; loading: boolean; validating: boolean; executing: boolean }>();
const emit = defineEmits<{ edit: [name: string, source: string]; validate: []; reload: [] }>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.validating || props.executing);
const entries = computed(
  () =>
    props.plan?.dependents.map((dependent) => ({
      name: dependent.name,
      dependent,
      issues: props.plan!.issues.filter((issue) => issue.objectName === dependent.name),
    })) ?? [],
);
function edit(name: string, event: Event) {
  emit("edit", name, (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <section class="space-y-3 text-sm" :aria-busy="busy">
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("objects.tableRenameCoverage") }}</p>
    <p v-if="loading || validating" role="status" class="text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="!plan || !plan.executable" role="status" class="text-muted-foreground">{{ t("objects.viewRenameValidationPending") }}</p>
    <p v-if="plan && !plan.metadataComplete" class="text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
    <div v-if="plan" class="rounded border border-border p-3">
      <p class="mb-2 font-medium">{{ t("objects.tableRenameObjects") }}</p>
      <ul class="space-y-1 text-xs text-muted-foreground">
        <li>TABLE · {{ plan.target.schema }}.{{ plan.target.oldName }} → {{ plan.target.schema }}.{{ plan.canonicalNewName }}</li>
        <li v-for="dependent in plan.dependents" :key="`${dependent.objectType}:${dependent.name}`">{{ dependent.objectType }} · {{ plan.target.schema }}.{{ dependent.name }}</li>
      </ul>
    </div>
    <ul v-if="plan?.issues.some((issue) => !issue.objectName || !entries.some((entry) => entry.name === issue.objectName))" class="space-y-2" aria-live="polite">
      <li v-for="(issue, index) in plan.issues.filter((item) => !item.objectName || !entries.some((entry) => entry.name === item.objectName))" :key="index" class="rounded border border-destructive/40 p-2">
        <p class="font-medium text-destructive">{{ issue.objectName || plan.target.oldName }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
        <p v-if="issue.location" class="text-xs text-muted-foreground">{{ t("objects.viewRenameIssueLocation", issue.location) }}</p>
        <details class="mt-1 text-xs text-muted-foreground" data-diagnostics>
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
        </details>
      </li>
    </ul>
    <details v-for="entry in entries" :key="`${entry.dependent.objectType}:${entry.name}`" :open="entry.issues.length > 0" class="rounded border border-border" :data-object-name="entry.name">
      <summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span class="min-w-0 break-all font-medium">{{ entry.dependent.objectType }} · {{ entry.name }}</span>
        <span class="shrink-0 rounded bg-muted px-2 py-0.5 text-xs" :class="entry.issues.length ? 'text-destructive' : 'text-muted-foreground'">
          {{ t(entry.issues.length ? "objects.viewRenameNeedsRepair" : "objects.viewRenameDefinitionReady") }}
        </span>
      </summary>
      <div class="space-y-3 border-t border-border p-3">
        <ul v-if="entry.issues.length" class="space-y-2" aria-live="polite">
          <li v-for="(issue, index) in entry.issues" :key="index" class="space-y-1">
            <p class="font-medium text-destructive">{{ issue.objectName }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
            <p v-if="issue.location" class="text-xs text-muted-foreground">{{ t("objects.viewRenameIssueLocation", issue.location) }}</p>
            <details class="text-xs text-muted-foreground" data-diagnostics>
              <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
            </details>
          </li>
        </ul>
        <label class="block space-y-1">
          <span class="block text-xs text-muted-foreground">{{ t("objects.tableRenameDraft", { schema: plan?.target.schema, name: entry.name }) }}</span>
          <textarea
            :value="drafts[entry.name] ?? entry.dependent.draft"
            :disabled="busy"
            spellcheck="false"
            rows="10"
            class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            @input="edit(entry.name, $event)"
          />
        </label>
        <div v-if="entry.dependent.rewrittenSource" class="space-y-1">
          <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }}</p>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ entry.dependent.rewrittenSource }}</pre>
        </div>
      </div>
    </details>
    <details v-if="plan?.executable && plan.statements.length" class="rounded border border-border">
      <summary class="cursor-pointer px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("objects.viewRenameFinalSql") }}</summary>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3 font-mono text-xs">{{ plan.statements.join("\n\n") }}</pre>
    </details>
    <div class="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" :disabled="busy || !plan" data-validate @click="emit('validate')">{{ t("objects.viewRenameValidate") }}</Button>
      <Button type="button" variant="outline" size="sm" :disabled="busy" data-reload @click="emit('reload')">{{ t("objects.viewRenameReload") }}</Button>
    </div>
  </section>
</template>
