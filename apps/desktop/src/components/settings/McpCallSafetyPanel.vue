<script setup lang="ts">
import { nextTick, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

const props = defineProps<{ mode: "off" | "full" | "high_risk"; disabled?: boolean }>();
const emit = defineEmits<{ "set:confirmation": [enabled: boolean] }>();
const { t } = useI18n();
const hintId = useId();
const expanded = ref(props.mode === "full");
const confirmationInput = ref<HTMLInputElement | null>(null);
async function setConfirmation(enabled: boolean) {
  if (props.disabled) return;
  const leavingLegacy = props.mode === "full";
  emit("set:confirmation", enabled);
  if (leavingLegacy) {
    await nextTick();
    confirmationInput.value?.focus();
  }
}
</script>

<template>
  <details class="min-w-0 space-y-3 rounded-md border bg-background p-3 sm:p-4" :open="expanded" data-mcp-call-safety @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary class="cursor-pointer rounded-sm text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {{ t("settings.mcpCallSafety") }}
      <span class="ml-2 text-xs font-normal text-muted-foreground" data-mcp-safety-status>{{ t(mode === "full" ? "settings.mcpCallSafetyLegacy" : mode === "high_risk" ? "settings.mcpCallSafetyEnabled" : "settings.mcpCallSafetyDisabled") }}</span>
    </summary>
    <template v-if="mode === 'full'">
      <p class="text-xs leading-relaxed text-muted-foreground" data-mcp-safety-legacy>{{ t("settings.mcpCallSafetyLegacyHint") }}</p>
      <div class="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" :disabled="disabled" data-mcp-safety-migrate @click="setConfirmation(true)">{{ t("settings.mcpCallSafetyMigrate") }}</Button>
        <Button type="button" size="sm" variant="ghost" :disabled="disabled" data-mcp-safety-disable-legacy @click="setConfirmation(false)">{{ t("settings.mcpCallSafetyDisableLegacy") }}</Button>
      </div>
    </template>
    <template v-else>
      <label class="flex items-center gap-2 text-xs">
        <input ref="confirmationInput" type="checkbox" class="shrink-0 accent-primary" :checked="mode === 'high_risk'" :disabled="disabled" :aria-describedby="hintId" data-mcp-high-risk-confirmation @change="setConfirmation(($event.target as HTMLInputElement).checked)" />
        {{ t("settings.mcpCallSafetyConfirm") }}
      </label>
      <p :id="hintId" class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpCallSafetyHint") }}</p>
      <p class="text-xs leading-relaxed text-muted-foreground">{{ t("settings.mcpCallSafetyDesktopHint") }}</p>
    </template>
  </details>
</template>
