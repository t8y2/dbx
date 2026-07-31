<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { AlertTriangle, Copy } from "@lucide/vue";

const { t } = useI18n();
const { toast } = useToast();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  message: string;
}>();

function handleCopy() {
  copyToClipboard(props.message);
  toast(t("diff.copied"), 2000);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5" />
          {{ t("diff.errorDetail") }}
        </DialogTitle>
      </DialogHeader>

      <div class="py-2">
        <pre class="text-xs bg-destructive/10 text-destructive p-3 rounded overflow-auto max-h-[60vh] font-mono whitespace-pre-wrap">{{ message }}</pre>
      </div>

      <DialogFooter class="flex items-center justify-between">
        <div class="text-xs text-muted-foreground">
          {{ t("diff.errorDetailHint") }}
        </div>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" class="h-8 text-xs gap-1" @click="handleCopy">
            <Copy class="w-3.5 h-3.5" />
            {{ t("diff.copyError") }}
          </Button>
          <Button size="sm" class="h-8 text-xs" @click="open = false">
            {{ t("diff.close") }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
