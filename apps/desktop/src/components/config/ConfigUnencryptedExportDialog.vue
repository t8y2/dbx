<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{ open: boolean; includeCredentials: boolean; busy?: boolean }>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:includeCredentials": [value: boolean];
  cancel: [];
  confirm: [];
}>();
const { t } = useI18n();
const includeCredentials = computed({
  get: () => props.includeCredentials,
  set: (value) => {
    if (!props.busy) emit("update:includeCredentials", value);
  },
});
</script>

<template>
  <Dialog :open="open" @update:open="!busy && emit('update:open', $event)">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ t("configExport.unencryptedWarningTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("configExport.plaintextDefaultDescription") }}</p>
      <label class="flex items-start gap-2 text-sm">
        <input v-model="includeCredentials" type="checkbox" class="mt-1" :disabled="busy" aria-describedby="plaintext-credentials-warning" />
        <span>{{ t("configExport.includeCredentials") }}</span>
      </label>
      <p id="plaintext-credentials-warning" class="text-sm" :class="includeCredentials ? 'text-destructive' : 'text-muted-foreground'">
        {{ t("configExport.plaintextCredentialsWarning") }}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" :disabled="busy" @click="emit('cancel')">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" :variant="includeCredentials ? 'destructive' : 'default'" :disabled="busy" @click="emit('confirm')">
          {{ t(includeCredentials ? "configExport.exportWithCredentials" : "configExport.exportWithoutCredentials") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
