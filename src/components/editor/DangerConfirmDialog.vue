<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { AlertTriangle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

withDefaults(defineProps<{
  sql?: string;
  title?: string;
  message?: string;
  details?: string;
  confirmLabel?: string;
}>(), {
  sql: "",
  title: "",
  message: "",
  details: "",
  confirmLabel: "",
});

const emit = defineEmits<{
  confirm: [];
}>();

function onConfirm() {
  open.value = false;
  emit("confirm");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5" />
          {{ title || t('dangerDialog.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="py-4">
        <p class="text-sm text-muted-foreground mb-3">{{ message || t('dangerDialog.message') }}</p>
        <pre v-if="details || sql" class="text-xs bg-muted p-3 rounded overflow-auto max-h-40 font-mono whitespace-pre-wrap">{{ details || sql }}</pre>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t('dangerDialog.cancel') }}</Button>
        <Button variant="destructive" @click="onConfirm">{{ confirmLabel || t('dangerDialog.confirm') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
