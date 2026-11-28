<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SqlFileOpenMode } from "@/lib/sqlFile/sqlFileInteraction";

export type SqlPanelDisplayMode = "folder" | "connection";

withDefaults(
  defineProps<{
    open: boolean;
    openMode: SqlFileOpenMode;
    openModeId?: string;
    displayMode?: SqlPanelDisplayMode;
    displayModeId?: string;
    displayModeLabel?: string;
    displayModeFolderLabel?: string;
    displayModeConnectionLabel?: string;
  }>(),
  {
    openModeId: "sql-file-open-mode",
    displayModeId: "sql-panel-display-mode",
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:openMode": [value: SqlFileOpenMode];
  "update:displayMode": [value: SqlPanelDisplayMode];
  save: [];
}>();

const { t } = useI18n();

function updateOpenMode(v: any) {
  emit("update:openMode", v === "double" ? "double" : "single");
}

function updateDisplayMode(v: any) {
  emit("update:displayMode", v === "connection" ? "connection" : "folder");
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
        <Select :id="openModeId" :model-value="openMode" @update:model-value="updateOpenMode">
          <SelectTrigger class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single">{{ t("sqlFileTree.openModeSingle") }}</SelectItem>
            <SelectItem value="double">{{ t("sqlFileTree.openModeDouble") }}</SelectItem>
          </SelectContent>
        </Select>

        <template v-if="displayMode">
          <Label :for="displayModeId">{{ displayModeLabel }}</Label>
          <Select :id="displayModeId" :model-value="displayMode" @update:model-value="updateDisplayMode">
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="folder">{{ displayModeFolderLabel }}</SelectItem>
              <SelectItem value="connection">{{ displayModeConnectionLabel }}</SelectItem>
            </SelectContent>
          </Select>
        </template>
        <slot />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button type="button" @click="emit('save')">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
