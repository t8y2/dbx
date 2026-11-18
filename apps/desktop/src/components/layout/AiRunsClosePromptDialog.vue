<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

defineProps<{ count: number }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ cancel: []; quit: [] }>();
const { t } = useI18n();

function handleOpenChange(value: boolean) {
  open.value = value;
  if (!value) emit("cancel");
}
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-[440px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("ai.closeWithRunsTitle") }}</DialogTitle>
        <DialogDescription>{{ t("ai.closeWithRunsDescription", { count }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button type="button" variant="outline" @click="emit('cancel')">{{ t("common.cancel") }}</Button>
        <Button type="button" variant="destructive" @click="emit('quit')">{{ t("ai.closeWithRunsQuit") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
