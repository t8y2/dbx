<script setup lang="ts">
import { Inbox, RefreshCcw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useI18n } from "vue-i18n";
import { formatShortcut } from "@/lib/editor/shortcutRegistry";

const emit = defineEmits<{ refresh: [] }>();
const { t } = useI18n();
const modRKeys = formatShortcut("Mod+R")
  .split("+")
  .map((key) => (key === "Cmd" ? "⌘" : key));
</script>

<template>
  <div class="flex size-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
    <Inbox class="h-8 w-8 opacity-60" />
    <div>{{ t("pluginPlatform.reloadRequired") }}</div>
    <div class="inline-flex items-center gap-1 text-xs text-muted-foreground/70">
      <span>{{ t("pluginPlatform.reloadHintPrefix") }}</span>
      <kbd v-for="key in modRKeys" :key="key" class="min-w-5 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-center font-mono text-[12px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
      <span>{{ t("pluginPlatform.reloadHintSuffix") }}</span>
    </div>
    <Button variant="outline" size="sm" class="h-7 gap-1.5" @click="emit('refresh')">
      <RefreshCcw class="h-3.5 w-3.5" />
      {{ t("pluginPlatform.refresh") }}
    </Button>
  </div>
</template>
