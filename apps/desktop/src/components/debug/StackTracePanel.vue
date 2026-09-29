<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();
</script>

<template>
  <div class="h-full overflow-auto p-2">
    <pre v-if="store.backtrace" class="whitespace-pre-wrap break-all font-mono text-xs">{{ store.backtrace }}</pre>
    <p v-else class="text-xs text-muted-foreground">{{ t("plDebug.stack.empty") }}</p>
  </div>
</template>
