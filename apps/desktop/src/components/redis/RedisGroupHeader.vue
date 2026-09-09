<script setup lang="ts">
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useId } from "vue";
import type { RedisVirtualGroupRow } from "@/lib/redis/redisKeyGroupIndex";

defineProps<{ row: RedisVirtualGroupRow; expanded: boolean; navigation?: boolean; omitted?: boolean; path?: string; stickyDepth?: number }>();
const emit = defineEmits<{ toggle: []; navigate: [] }>();
const { t } = useI18n();
const pathHintId = useId();
</script>

<template>
  <div v-if="navigation" class="group/redis-sticky relative flex h-[30px] items-center gap-1 border-b bg-background px-2 text-xs" :style="{ paddingLeft: `${8 + (stickyDepth ?? row.depth) * 10}px` }" :title="path">
    <button type="button" class="flex h-6 w-5 shrink-0 items-center justify-center hover:bg-accent/40 focus-visible:outline focus-visible:outline-ring" data-redis-sticky-toggle :aria-label="row.label" :aria-describedby="pathHintId" :aria-expanded="expanded" @click="emit('toggle')">
      <component :is="expanded ? ChevronDown : ChevronRight" class="h-3 w-3" />
    </button>
    <button type="button" class="flex h-full min-w-0 flex-1 items-center gap-1 text-left hover:bg-accent/40 focus-visible:outline focus-visible:outline-ring" data-redis-sticky-navigate :aria-label="row.label" :aria-describedby="pathHintId" :title="path" @click="emit('navigate')">
      <span v-if="omitted" aria-hidden="true">…</span>
      <span class="truncate">{{ row.label }}</span>
      <span class="shrink-0 text-muted-foreground">{{ t("redisGrouping.count", { count: row.count }) }}</span>
    </button>
    <span :id="pathHintId" role="tooltip" class="pointer-events-none absolute inset-x-0 top-full z-30 hidden break-all rounded border bg-popover p-2 text-popover-foreground shadow-md group-hover/redis-sticky:block group-focus-within/redis-sticky:block">{{ path }}</span>
  </div>
  <div
    v-else
    class="flex h-[30px] cursor-pointer items-center gap-1 border-b px-2 text-xs hover:bg-accent/40 focus-visible:outline focus-visible:outline-ring focus-visible:outline-offset-[-2px]"
    :style="{ paddingLeft: `${8 + row.depth * 10}px` }"
    role="button"
    tabindex="0"
    :aria-expanded="expanded"
    @click="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <component :is="expanded ? ChevronDown : ChevronRight" class="h-3 w-3 shrink-0" />
    <span class="truncate">{{ row.label }}</span>
    <span class="shrink-0 text-muted-foreground">{{ t("redisGrouping.count", { count: row.count }) }}</span>
  </div>
</template>
