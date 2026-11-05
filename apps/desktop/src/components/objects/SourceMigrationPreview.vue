<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

export interface SourceMigrationEntry {
  key: string;
  name: string;
  owner?: string;
  objectType: string;
  source: string;
  draft: string;
  generated: string;
  rewriteRequired: boolean;
  editable?: boolean;
  showOriginal?: boolean;
  currentSource?: string;
}
export interface SourceMigrationIssue {
  objectKey?: string;
  label?: string;
  message: string;
  repairable: boolean;
}
const props = defineProps<{
  entries: SourceMigrationEntry[];
  issues: SourceMigrationIssue[];
  drafts: Record<string, string>;
  statements: string[];
  loading: boolean;
  validating: boolean;
  executing: boolean;
  executable: boolean;
  ready: boolean;
  draftLabel?: string;
  validationPendingMessage?: string;
}>();
const emit = defineEmits<{ edit: [key: string, source: string]; validate: []; reload: [] }>();
const { t } = useI18n();
const id = useId();
const busy = computed(() => props.loading || props.validating || props.executing);
const assigned = computed(() => new Set(props.entries.map((entry) => entry.key)));
const statementsCurrent = computed(() => props.entries.every((entry) => isCurrentDraft(entry.key, entry.draft)));
const issuesFor = (key: string) => props.issues.filter((issue) => issue.objectKey === key);
function isCurrentDraft(key: string, draft: string) {
  return (props.drafts[key] ?? draft) === draft;
}
</script>

<template>
  <section class="space-y-3 text-sm" :aria-busy="busy">
    <slot />
    <p v-if="loading || validating" role="status" class="text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="!executable" role="status" class="text-destructive">{{ validationPendingMessage ?? t("objects.viewRenameValidationPending") }}</p>
    <ul v-if="issues.some((issue) => !issue.objectKey || !assigned.has(issue.objectKey))" class="space-y-2" aria-live="polite">
      <li v-for="(issue, index) in issues.filter((item) => !item.objectKey || !assigned.has(item.objectKey))" :key="index" class="rounded border border-destructive/40 p-3">
        <p class="font-medium text-destructive">{{ issue.label || t("objects.viewRenameNeedsRepair") }}</p>
        <p v-if="!issue.repairable" class="text-xs text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
        <details class="mt-1 text-xs text-muted-foreground" data-diagnostics>
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
        </details>
      </li>
    </ul>
    <details v-for="(entry, index) in entries" :key="entry.key" :open="issuesFor(entry.key).length > 0" class="rounded border border-border" :data-source-name="entry.key">
      <summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span class="min-w-0 break-all font-medium">{{ entry.objectType }} · {{ entry.owner ? `${entry.owner}.` : "" }}{{ entry.name }}</span>
        <span class="shrink-0 rounded bg-muted px-2 py-0.5 text-xs" :class="issuesFor(entry.key).length ? 'text-destructive' : 'text-muted-foreground'">{{ t(issuesFor(entry.key).length ? "objects.viewRenameNeedsRepair" : "objects.viewRenameDefinitionReady") }}</span>
      </summary>
      <div class="space-y-3 border-t border-border p-3">
        <details v-if="entry.showOriginal && entry.source" class="text-xs text-muted-foreground">
          <summary class="cursor-pointer">{{ t("contextMenu.viewSource") }}</summary>
          <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">{{ entry.source }}</pre>
        </details>
        <details v-if="entry.currentSource && entry.currentSource !== entry.source && entry.currentSource !== (drafts[entry.key] ?? entry.draft)" open class="text-xs text-muted-foreground" data-current-source>
          <summary class="cursor-pointer">{{ t("objects.typeManagementCurrentSource") }}</summary>
          <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">{{ entry.currentSource }}</pre>
        </details>
        <ul v-if="issuesFor(entry.key).length" class="space-y-2" aria-live="polite">
          <li v-for="(issue, issueIndex) in issuesFor(entry.key)" :key="issueIndex" class="space-y-1">
            <p class="font-medium text-destructive">{{ entry.name }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
            <p v-if="!issue.repairable" class="text-xs text-destructive">{{ t("objects.viewRenameMetadataProblem") }}</p>
            <details class="text-xs text-muted-foreground" data-diagnostics>
              <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
            </details>
          </li>
        </ul>
        <label v-if="entry.rewriteRequired" class="block space-y-1" :for="`${id}-draft-${index}`">
          <span class="block text-xs text-muted-foreground">{{ draftLabel ?? t("objects.viewRenameDraft") }} · {{ entry.owner ? `${entry.owner}.` : "" }}{{ entry.name }}</span>
          <textarea
            :id="`${id}-draft-${index}`"
            :value="drafts[entry.key] ?? entry.draft"
            :disabled="busy || entry.editable === false"
            spellcheck="false"
            rows="10"
            class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            :data-source-draft="entry.key"
            @input="emit('edit', entry.key, ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
        <div v-if="entry.generated && isCurrentDraft(entry.key, entry.draft)" class="space-y-1">
          <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }}</p>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ entry.generated }}</pre>
        </div>
      </div>
    </details>
    <details v-if="statementsCurrent && statements.length" class="rounded border border-border" open>
      <summary class="cursor-pointer px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("objects.viewRenameFinalSql") }}</summary>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3 font-mono text-xs">{{ statements.join("\n\n") }}</pre>
    </details>
    <div class="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" :disabled="busy || !ready" data-validate @click="emit('validate')">{{ t("objects.viewRenameValidate") }}</Button>
      <Button type="button" variant="outline" size="sm" :disabled="busy" data-reload @click="emit('reload')">{{ t("objects.viewRenameReload") }}</Button>
    </div>
  </section>
</template>
