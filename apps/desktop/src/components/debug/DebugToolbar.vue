<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Play, Redo2, Square } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();

const stateLabel = computed(() => {
  if (store.terminated) return t("plDebug.state.finished");
  if (store.busy) return t("plDebug.state.running");
  return t("plDebug.state.paused");
});
</script>

<template>
  <div class="flex items-center gap-1 border-b px-2 py-1">
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.resume')" @click="store.resume()">
      <Loader2 v-if="store.busy" class="h-4 w-4 animate-spin" />
      <Play v-else class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepOver')" @click="store.stepOver()">
      <Redo2 class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepIn')" @click="store.stepIn()">
      <ArrowDownToLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="store.busy || store.terminated || !store.hasSession" :title="t('plDebug.toolbar.stepOut')" @click="store.stepOut()">
      <ArrowUpFromLine class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="sm" :disabled="!store.hasSession" :title="t('plDebug.toolbar.abort')" @click="store.abort()">
      <Square class="h-4 w-4" />
    </Button>
    <span class="mx-2 text-xs text-muted-foreground">{{ stateLabel }}</span>
    <span v-if="store.currentProgram" class="text-xs text-muted-foreground">
      {{ store.currentProgram }}<template v-if="store.currentLine"> : {{ store.currentLine }}</template>
    </span>
    <span v-if="store.error" class="ml-auto truncate text-xs text-destructive" :title="store.error">
      {{ store.error }}
    </span>
  </div>
</template>
