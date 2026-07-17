<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const open = defineModel<boolean>("open", { required: true });

const emit = defineEmits<{
  quit: [];
  minimize: [];
}>();

const { t } = useI18n();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[440px]" @interact-outside.prevent @escape-key-down.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.closeActionPromptTitle") }}</DialogTitle>
        <DialogDescription>{{ t("settings.closeActionPromptDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button type="button" variant="outline" @click="emit('minimize')">
          {{ t("settings.closeActionMinimize") }}
        </Button>
        <Button type="button" @click="emit('quit')">
          {{ t("settings.closeActionQuit") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
