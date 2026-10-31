<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FOREIGN_KEY_CHECKS_MODES, type ForeignKeyChecksMode } from "@/lib/table/foreignKeyChecks";

const mode = defineModel<ForeignKeyChecksMode>({ default: "default" });
defineProps<{ disabled?: boolean }>();

const { t } = useI18n();
const labelKeys: Record<ForeignKeyChecksMode, string> = {
  default: "contextMenu.foreignKeyChecksDefault",
  enable: "contextMenu.foreignKeyChecksEnable",
  disable: "contextMenu.foreignKeyChecksDisable",
};
</script>

<template>
  <div class="mb-3 grid gap-1 rounded-md border bg-muted/20 px-3 py-2 text-sm" data-testid="foreign-key-checks-option">
    <div class="flex items-center gap-3">
      <span class="font-medium text-foreground">{{ t("contextMenu.foreignKeyChecks") }}</span>
      <Select v-model="mode" :disabled="disabled">
        <SelectTrigger class="h-7 w-32 text-xs" data-testid="foreign-key-checks-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="value in FOREIGN_KEY_CHECKS_MODES" :key="value" :value="value">{{ t(labelKeys[value]) }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.foreignKeyChecksHint") }}</span>
  </div>
</template>
