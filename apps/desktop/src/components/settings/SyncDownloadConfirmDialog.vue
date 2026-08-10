<script setup lang="ts">
import { AlertTriangle } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const open = defineModel<boolean>("open", { required: true });

const emit = defineEmits<{
  confirm: [];
}>();

const { t } = useI18n();

function confirmDownload() {
  open.value = false;
  emit("confirm");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <AlertTriangle class="h-5 w-5 text-destructive" />
          {{ t("settings.syncDownload") }}
        </DialogTitle>
        <DialogDescription>{{ t("settings.syncDownloadConfirm") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" variant="destructive" @click="confirmDownload">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
