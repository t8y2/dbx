<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";

const props = defineProps<{
  open: boolean;
  oldName: string;
  newName: string;
  plan: OraclePackageSaveAsPlan | null;
  drafts: { spec?: string; body?: string };
  error: string;
  diagnostic: string;
  loading: boolean;
  validating: boolean;
  executing: boolean;
}>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:newName": [value: string];
  edit: [part: "spec" | "body", source: string];
  validate: [];
  reload: [];
  confirm: [];
}>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.validating || props.executing);
const currentSpecDraft = computed(() => (props.drafts.spec ?? props.plan?.specDraft) === props.plan?.specDraft);
const currentBodyDraft = computed(() => (props.drafts.body ?? props.plan?.bodyDraft) === props.plan?.bodyDraft);
function edit(part: "spec" | "body", event: Event) {
  emit("edit", part, (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[min(90vw,900px)]">
      <DialogHeader>
        <DialogTitle>{{ t("objects.packageSaveAsTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <p class="text-sm text-muted-foreground">{{ t("objects.packageSaveAsHint", { name: oldName }) }}</p>
        <Input :model-value="newName" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" :disabled="busy" @update:model-value="emit('update:newName', $event)" />
        <p v-if="loading || validating" role="status" class="text-sm text-muted-foreground">{{ t("common.loading") }}</p>
        <div v-if="plan" class="grid gap-2">
          <p v-if="!plan.metadataComplete" class="text-sm text-destructive">{{ t("objects.packageSaveAsMetadataProblem") }}</p>
          <ul v-if="plan.issues.length" class="list-disc space-y-1 pl-5 text-sm text-destructive" aria-live="polite">
            <li v-for="(issue, index) in plan.issues" :key="index">
              {{ issue.objectName || t("objects.packageSaveAsMetadataProblem") }} · {{ issue.repairable ? t("objects.viewRenameNeedsRepair") : t("objects.packageSaveAsMetadataProblem") }}
              <details class="mt-1 text-xs text-muted-foreground">
                <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
                <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
              </details>
            </li>
          </ul>
          <p v-if="plan.snapshot" class="text-xs text-muted-foreground">
            {{ t("objects.package") }} · {{ plan.target.schema }}.{{ plan.target.oldName }}
            <span v-if="plan.bodySource !== null"> · {{ t("objects.packageBody") }}</span>
          </p>
          <label v-if="plan.snapshot" class="grid gap-1 text-xs text-muted-foreground">
            <span>{{ t("objects.package") }} · {{ plan.target.schema }}.{{ plan.target.oldName }}</span>
            <textarea
              :value="drafts.spec ?? plan.specDraft"
              :disabled="busy"
              spellcheck="false"
              rows="8"
              class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              data-source-draft="spec"
              @input="edit('spec', $event)"
            />
          </label>
          <label v-if="plan.bodyDraft !== null" class="grid gap-1 text-xs text-muted-foreground">
            <span>{{ t("objects.packageBody") }} · {{ plan.target.schema }}.{{ plan.target.oldName }}</span>
            <textarea
              :value="drafts.body ?? plan.bodyDraft"
              :disabled="busy"
              spellcheck="false"
              rows="10"
              class="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              data-source-draft="body"
              @input="edit('body', $event)"
            />
          </label>
          <div v-if="plan.specSource && currentSpecDraft" class="grid gap-1">
            <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }} · {{ t("objects.package") }}</p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ plan.specSource }}</pre>
          </div>
          <div v-if="plan.bodySource && currentBodyDraft" class="grid gap-1">
            <p class="text-xs text-muted-foreground">{{ t("objects.viewRenameFinalSql") }} · {{ t("objects.packageBody") }}</p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ plan.bodySource }}</pre>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" :disabled="busy || !plan.snapshot" data-validate @click="emit('validate')">{{ t("objects.viewRenameValidate") }}</Button>
            <Button type="button" variant="outline" size="sm" :disabled="busy" data-reload @click="emit('reload')">{{ t("objects.viewRenameReload") }}</Button>
          </div>
          <pre v-if="plan.executable && currentSpecDraft && currentBodyDraft && plan.statements.length" class="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs">{{ plan.statements.join("\n\n") }}</pre>
        </div>
        <p v-if="error" class="break-words text-sm text-destructive">{{ error }}</p>
        <details v-if="diagnostic" class="text-xs text-muted-foreground">
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ diagnostic }}</pre>
        </details>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="executing" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button data-confirm :disabled="busy || !plan?.executable || !newName.trim() || newName.trim() === oldName" @click="emit('confirm')">
          {{ t("objects.packageSaveAsTitle") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
