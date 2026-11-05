<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { OracleViewRenamePlan } from "@/lib/table/oracleViewRename";
import type { OracleViewRenameIssue } from "@/types/database";

const props = defineProps<{ plan: OracleViewRenamePlan | null; drafts: Record<string, string>; loading: boolean; validating: boolean; executing: boolean }>();
const emit = defineEmits<{ edit: [name: string, source: string]; validate: []; reload: [] }>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.validating || props.executing);
const entries = computed(() => {
  if (!props.plan) return [];
  const names = new Set(props.plan.views.map((view) => view.name));
  const unassigned = props.plan.issues.filter((issue) => !issue.viewName || !names.has(issue.viewName));
  return [...(unassigned.length ? [{ name: "", view: null, issues: unassigned }] : []), ...props.plan.views.map((view) => ({ name: view.name, view, issues: props.plan!.issues.filter((issue) => issue.viewName === view.name) }))];
});
const issueLabels: Record<string, string> = {
  unsupported_hint: "viewRenameIssueHint",
  hint_capture: "viewRenameIssueBinding",
  ambiguous_binding: "viewRenameIssueBinding",
  invalid_definition: "viewRenameNeedsRepair",
  invalid_declaration: "viewRenameIssueDeclaration",
  manual_graph: "viewRenameIssueGraph",
  manual_new_name: "viewRenameIssueGraph",
  invalid_name: "viewRenameIssueName",
  target_conflict: "viewRenameIssueName",
  owner_mismatch: "viewRenameIssueState",
  invalid_object: "viewRenameIssueState",
  source_read_failed: "viewRenameIssueSource",
  grants_read_failed: "viewRenameIssueSource",
  metadata_incomplete: "viewRenameIssueSource",
  invalid_metadata: "viewRenameIssueState",
  dependency_scope: "viewRenameIssueDependency",
  dependency_cycle: "viewRenameIssueDependency",
  dependency_read_failed: "viewRenameIssueDependency",
  metadata_drift: "viewRenameIssueDrift",
};
function issueLabel(issue: OracleViewRenameIssue) {
  return t(`objects.${issueLabels[issue.code] || "viewRenameNeedsRepair"}`);
}
function edit(name: string, event: Event) {
  emit("edit", name, (event.target as HTMLTextAreaElement).value);
}
function isCurrentDraft(name: string, validatedDraft: string) {
  return (props.drafts[name] ?? validatedDraft) === validatedDraft;
}
</script>

<template>
  <section class="space-y-3 text-sm" :aria-busy="busy">
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("objects.viewRenameCoverage") }}</p>
    <p v-if="loading || validating" role="status" class="text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="!plan || !plan.executable" role="status" class="text-muted-foreground">{{ t("objects.viewRenameValidationPending") }}</p>
    <p v-if="plan && !plan.metadataComplete" class="text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
    <details v-for="entry in entries" :key="entry.name" :open="entry.issues.length > 0" class="rounded border border-border" :data-view-name="entry.name">
      <summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span class="min-w-0 break-all font-medium">{{ entry.name || t("objects.viewRenameMetadataProblem") }}</span>
        <span class="shrink-0 rounded bg-muted px-2 py-0.5 text-xs" :class="entry.issues.length ? 'text-destructive' : 'text-muted-foreground'">
          {{ t(entry.issues.length ? "objects.viewRenameNeedsRepair" : "objects.viewRenameDefinitionReady") }}
        </span>
      </summary>
      <div class="space-y-3 border-t border-border p-3">
        <ul v-if="entry.issues.length" class="space-y-3" aria-live="polite">
          <li v-for="(issue, index) in entry.issues" :key="index" class="space-y-1">
            <p class="font-medium text-destructive">
              {{ issueLabel(issue) }}<span v-if="issue.viewName"> · {{ issue.viewName }}</span>
            </p>
            <code v-if="issue.hintText" class="block whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 text-xs">{{ issue.hintText }}</code>
            <p v-if="issue.location" class="text-xs text-muted-foreground">{{ t("objects.viewRenameIssueLocation", { line: issue.location.line, column: issue.location.column }) }}</p>
            <p v-if="!issue.repairable" class="text-xs text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
            <details class="text-xs text-muted-foreground" data-diagnostics>
              <summary class="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("objects.viewRenameDiagnostics") }}</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
            </details>
          </li>
        </ul>
        <label v-if="entry.view" class="block space-y-1">
          <span class="block text-xs text-muted-foreground">{{ t("objects.viewRenameDraft") }} · {{ plan?.target.schema }}.{{ entry.name }}</span>
          <textarea
            :value="drafts[entry.name] ?? entry.view.source"
            :disabled="busy || (!entry.view.source.trim() && drafts[entry.name] === undefined)"
            spellcheck="false"
            rows="10"
            class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            @input="edit(entry.name, $event)"
          />
        </label>
        <div v-if="entry.view?.rewrittenSource && isCurrentDraft(entry.name, entry.view.draft)" class="space-y-1">
          <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }}</p>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ entry.view.rewrittenSource }}</pre>
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
