<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Lock, Unlock } from "@lucide/vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectionStore } from "@/stores/connectionStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import { formatWriteUnlockRemaining } from "@/lib/database/readOnlyWriteAccess";

const props = defineProps<{
  connectionId: string;
  compact?: boolean;
  showLabel?: boolean;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const unlockStore = useReadOnlyUnlockStore();

const persistentlyReadOnly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only === true);
const remainingMs = computed(() => unlockStore.remainingMs(props.connectionId));
const unlocked = computed(() => remainingMs.value > 0);
const remainingLabel = computed(() => formatWriteUnlockRemaining(remainingMs.value));
const tooltip = computed(() => {
  if (unlocked.value) return `${t("readOnlyUnlock.unlockedBadge")} · ${t("readOnlyUnlock.remaining", { time: remainingLabel.value })}`;
  return t("connection.readOnlyBadge");
});

async function onActivate() {
  if (!persistentlyReadOnly.value) return;
  if (unlocked.value) {
    await unlockStore.lockNow(props.connectionId);
    return;
  }
  await unlockStore.requestUnlock({
    connectionId: props.connectionId,
    connectionName: connectionStore.getConfig(props.connectionId)?.name,
    source: t("readOnlyUnlock.sourceStatus"),
  });
}

watch(
  () => props.connectionId,
  (connectionId) => {
    if (persistentlyReadOnly.value) void unlockStore.refreshFromBackend(connectionId);
  },
);

onMounted(() => {
  if (persistentlyReadOnly.value) void unlockStore.refreshFromBackend(props.connectionId);
});
</script>

<template>
  <Tooltip v-if="persistentlyReadOnly">
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-flex items-center gap-0.5 rounded text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="compact ? 'h-4 px-0.5' : 'h-4 px-1'"
        :aria-label="unlocked ? t('readOnlyUnlock.lockNow') : t('readOnlyUnlock.unlockAction')"
        :title="unlocked ? t('readOnlyUnlock.lockNow') : t('readOnlyUnlock.unlockAction')"
        @click.stop.prevent="onActivate"
      >
        <Unlock v-if="unlocked" class="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
        <Lock v-else class="h-3 w-3 shrink-0" />
        <span v-if="showLabel && !unlocked" class="text-[10px] leading-none">{{ t("connection.readOnlyBadge") }}</span>
        <span v-if="unlocked" class="text-[10px] tabular-nums leading-none">{{ remainingLabel }}</span>
      </button>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip }}</TooltipContent>
  </Tooltip>
</template>
