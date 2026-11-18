<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SqlFileOpenMode } from "@/lib/sqlFile/sqlFileInteraction";

withDefaults(
  defineProps<{
    open: boolean;
    openMode: SqlFileOpenMode;
    openModeId?: string;
  }>(),
  {
    openModeId: "sql-file-open-mode",
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:openMode": [value: SqlFileOpenMode];
  save: [];
}>();

const { t } = useI18n();

function updateOpenMode(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit("update:openMode", value === "double" ? "double" : "single");
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("sqlFileTree.panelSettings") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-2 py-2">
        <Label :for="openModeId">{{ t("sqlFileTree.openMode") }}</Label>
        <select :id="openModeId" :value="openMode" class="h-8 rounded-md border border-input bg-background px-2 text-sm" @change="updateOpenMode">
          <option value="single">{{ t("sqlFileTree.openModeSingle") }}</option>
          <option value="double">{{ t("sqlFileTree.openModeDouble") }}</option>
        </select>
        <slot />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button type="button" @click="emit('save')">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
