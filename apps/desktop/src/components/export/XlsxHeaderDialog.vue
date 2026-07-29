<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
const selected = ref<"original" | "comment">("original");

const emit = defineEmits<{
  confirm: [useCommentHeader: boolean];
  cancel: [];
}>();

function onConfirm() {
  open.value = false;
  emit("confirm", selected.value === "comment");
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
        <DialogTitle>{{ t("grid.xlsxHeaderTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="py-2">
        <p class="text-sm text-muted-foreground mb-3">{{ t("grid.xlsxHeaderPrompt") }}</p>
        <div class="flex flex-col gap-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" v-model="selected" value="original" class="h-4 w-4" />
            <span class="text-sm">{{ t("grid.xlsxHeaderOriginal") }}</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" v-model="selected" value="comment" class="h-4 w-4" />
            <span class="text-sm">{{ t("grid.xlsxHeaderComment") }}</span>
          </label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onCancel">{{ t("common.cancel") }}</Button>
        <Button @click="onConfirm">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
