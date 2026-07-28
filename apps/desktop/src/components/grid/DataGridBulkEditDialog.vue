<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const value = defineModel<string>("value", { default: "" });
defineProps<{ selectedCellCount: number }>();
const emit = defineEmits<{ apply: [] }>();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader
        ><DialogTitle>{{ t("grid.bulkEditTitle") }}</DialogTitle></DialogHeader
      >
      <div class="space-y-2">
        <p class="text-sm text-muted-foreground">{{ t("grid.bulkEditDescription", { count: selectedCellCount }) }}</p>
        <textarea
          v-model="value"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          rows="5"
          class="dbx-data-grid-value-font min-h-24 w-full min-w-0 resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          :placeholder="t('grid.bulkEditValuePlaceholder')"
          @keydown.ctrl.enter.prevent="emit('apply')"
          @keydown.meta.enter.prevent="emit('apply')"
        />
      </div>
      <DialogFooter
        ><Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button
        ><Button @click="emit('apply')">{{ t("grid.applyBulkEdit") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
