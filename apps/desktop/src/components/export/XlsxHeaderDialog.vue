<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { XlsxExportOptions, XlsxHeaderMode } from "@/lib/export/xlsxHeader";

const { t } = useI18n();

const props = withDefaults(defineProps<{ showHeaderOptions?: boolean }>(), {
  showHeaderOptions: true,
});
const open = defineModel<boolean>("open", { default: false });
const selected = ref<XlsxHeaderMode>("name");
const autoFilter = ref(false);

const emit = defineEmits<{
  confirm: [options: XlsxExportOptions];
  cancel: [];
}>();

function onConfirm() {
  open.value = false;
  emit("confirm", { headerMode: selected.value, autoFilter: autoFilter.value });
}

function onCancel() {
  open.value = false;
  emit("cancel");
}

function onOpenChange(value: boolean) {
  if (!value) onCancel();
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-sm" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("grid.xlsxExportTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-5 py-2">
        <div v-if="props.showHeaderOptions">
          <p class="mb-3 text-sm text-muted-foreground">{{ t("grid.xlsxHeaderPrompt") }}</p>
          <div class="flex flex-col gap-3">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" v-model="selected" value="name" class="h-4 w-4" />
              <span class="text-sm">{{ t("grid.xlsxHeaderOriginal") }}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" v-model="selected" value="comment" class="h-4 w-4" />
              <span class="text-sm">{{ t("grid.xlsxHeaderComment") }}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" v-model="selected" value="name-comment" class="h-4 w-4" />
              <span class="text-sm">{{ t("grid.xlsxHeaderNameAndComment") }}</span>
            </label>
          </div>
        </div>
        <div class="space-y-3">
          <p class="text-sm text-muted-foreground">{{ t("grid.xlsxFilterPrompt") }}</p>
          <label class="flex cursor-pointer items-center gap-2">
            <input v-model="autoFilter" type="checkbox" class="h-4 w-4" />
            <span class="text-sm">{{ t("grid.xlsxIncludeAutoFilter") }}</span>
          </label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onCancel">{{ t("common.cancel") }}</Button>
        <Button data-xlsx-header-confirm @click="onConfirm">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
