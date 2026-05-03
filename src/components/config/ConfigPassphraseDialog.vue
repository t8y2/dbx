<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Lock } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{
  open: boolean;
  mode: "export" | "import";
  externalError?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "confirm": [passphrase: string];
}>();

const { t } = useI18n();
const dialogOpen = computed({
  get: () => props.open,
  set: (v) => emit("update:open", v),
});

const passphrase = ref("");
const passphraseConfirm = ref("");
const error = ref("");

watch(dialogOpen, (open) => {
  if (open) {
    passphrase.value = "";
    passphraseConfirm.value = "";
    error.value = "";
  }
});

function confirm() {
  if (!passphrase.value) {
    error.value = t("configExport.passphraseRequired");
    return;
  }
  if (props.mode === "export" && passphrase.value !== passphraseConfirm.value) {
    error.value = t("configExport.passphraseMismatch");
    return;
  }
  if (props.mode === "export" && passphrase.value.length < 4) {
    error.value = t("configExport.passphraseTooShort");
    return;
  }
  emit("confirm", passphrase.value);
}

const displayError = computed(() => error.value || props.externalError || "");
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Lock class="h-5 w-5" />
          {{ mode === 'export' ? t('configExport.passphraseTitle') : t('configExport.passphraseImportTitle') }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid gap-4 py-4">
        <p class="text-sm text-muted-foreground">
          {{ mode === 'export' ? t('configExport.passphraseExportHint') : t('configExport.passphraseImportHint') }}
        </p>

        <div class="grid gap-2">
          <Label>{{ t('configExport.passphrase') }}</Label>
          <Input
            v-model="passphrase"
            type="password"
            :placeholder="t('configExport.passphrasePlaceholder')"
            @keydown.enter="mode === 'import' ? confirm() : undefined"
          />
        </div>

        <div v-if="mode === 'export'" class="grid gap-2">
          <Label>{{ t('configExport.passphraseConfirm') }}</Label>
          <Input
            v-model="passphraseConfirm"
            type="password"
            :placeholder="t('configExport.passphraseConfirmPlaceholder')"
            @keydown.enter="confirm"
          />
        </div>

        <p v-if="displayError" class="text-sm text-destructive">{{ displayError }}</p>
      </div>

      <DialogFooter>
        <Button @click="confirm">
          {{ mode === 'export' ? t('configExport.exportEncrypted') : t('configExport.decryptImport') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
