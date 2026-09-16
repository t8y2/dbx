<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, FileWarning } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ExternalSqlFilePrompt, ExternalSqlFilePromptDecision } from "@/composables/useExternalSqlFileChanges";

const props = defineProps<{
  prompt: ExternalSqlFilePrompt | null;
}>();

const emit = defineEmits<{
  decide: [decision: ExternalSqlFilePromptDecision];
}>();

const { t } = useI18n();
const isOpen = computed(() => props.prompt !== null);
</script>

<template>
  <Dialog :open="isOpen">
    <DialogContent :show-close-button="false" class="sm:max-w-[560px]" @interact-outside.prevent @escape-key-down.prevent>
      <template v-if="prompt">
        <DialogHeader>
          <div class="flex items-start gap-3 pr-2">
            <div class="mt-0.5 rounded-md bg-amber-500/12 p-2 text-amber-600 dark:text-amber-400">
              <FileWarning v-if="prompt.kind === 'deleted'" class="h-5 w-5" />
              <AlertTriangle v-else class="h-5 w-5" />
            </div>
            <div class="min-w-0 space-y-1 text-left">
              <DialogTitle>{{ t(prompt.kind === "modified" ? "externalSqlFile.modifiedTitle" : "externalSqlFile.deletedTitle") }}</DialogTitle>
              <DialogDescription class="break-all">
                {{ t(prompt.kind === "modified" ? "externalSqlFile.modifiedDescription" : "externalSqlFile.deletedDescription", { path: prompt.path }) }}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p v-if="prompt.dirty" class="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {{ t(prompt.kind === "deleted" ? "externalSqlFile.deletedUnsavedWarning" : "externalSqlFile.unsavedWarning") }}
        </p>

        <DialogFooter v-if="prompt.kind === 'modified' && prompt.context === 'reload'" class="gap-2 sm:gap-2">
          <Button variant="outline" @click="emit('decide', 'keep')">{{ t("externalSqlFile.keepEditor") }}</Button>
          <Button @click="emit('decide', 'load')">{{ t("externalSqlFile.loadLatest") }}</Button>
        </DialogFooter>

        <DialogFooter v-else-if="prompt.kind === 'modified'" class="flex-wrap gap-2 sm:gap-2">
          <Button variant="outline" @click="emit('decide', 'cancel')">{{ t("externalSqlFile.cancelSave") }}</Button>
          <Button variant="outline" @click="emit('decide', 'load')">{{ t("externalSqlFile.loadExternal") }}</Button>
          <Button variant="destructive" @click="emit('decide', 'overwrite')">{{ t("externalSqlFile.overwriteSave") }}</Button>
        </DialogFooter>

        <DialogFooter v-else class="flex-wrap gap-2 sm:gap-2">
          <Button variant="ghost" @click="emit('decide', 'close')">{{ t("externalSqlFile.closeTab") }}</Button>
          <Button variant="outline" @click="emit('decide', 'keep')">{{ t("externalSqlFile.keepEditing") }}</Button>
          <Button variant="outline" @click="emit('decide', 'saveAs')">{{ t("externalSqlFile.saveAs") }}</Button>
          <Button @click="emit('decide', 'recreate')">{{ t("externalSqlFile.recreate") }}</Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
