<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ExportExecutionMode from "./ExportExecutionMode.vue";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";

const { t } = useI18n();
const mode = ref<ManualExportMode>("immediate");
const open = defineModel<boolean>("open", { default: true });
const emit = defineEmits<{ confirm: [mode: ManualExportMode]; cancel: [] }>();
</script>

<template>
  <Dialog
    v-model:open="open"
    @update:open="
      (value) => {
        if (!value) emit('cancel');
      }
    "
  >
    <DialogContent class="sm:max-w-sm" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("grid.export") }}</DialogTitle>
      </DialogHeader>
      <ExportExecutionMode v-model="mode" class="py-3" />
      <DialogFooter>
        <Button variant="outline" @click="emit('cancel')">{{ t("common.cancel") }}</Button>
        <Button @click="emit('confirm', mode)">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
