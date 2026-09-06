<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { SqlInsertMode } from "@/lib/export/sqlInsertMode";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const selected = ref<SqlInsertMode>("batch");
let outcomeEmitted = false;

const emit = defineEmits<{
  confirm: [mode: SqlInsertMode];
  cancel: [];
}>();

function onConfirm() {
  outcomeEmitted = true;
  open.value = false;
  emit("confirm", selected.value);
}

function onCancel() {
  if (outcomeEmitted) return;
  outcomeEmitted = true;
  open.value = false;
  emit("cancel");
}

function onOpenChange(value: boolean) {
  if (!value) onCancel();
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("grid.sqlInsertModeTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 py-2">
        <p class="text-sm text-muted-foreground">{{ t("grid.sqlInsertModePrompt") }}</p>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="selected" type="radio" value="batch" class="mt-0.5 h-4 w-4 shrink-0" data-sql-insert-mode="batch" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.sqlInsertModeBatch") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.sqlInsertModeBatchDescription") }}</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="selected" type="radio" value="single" class="mt-0.5 h-4 w-4 shrink-0" data-sql-insert-mode="single" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.sqlInsertModeSingle") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.sqlInsertModeSingleDescription") }}</span>
          </span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onCancel">{{ t("common.cancel") }}</Button>
        <Button data-sql-insert-mode-confirm @click="onConfirm">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
