<script setup lang="ts">
import { computed } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { clampConsulPage, consulPageCount } from "@/lib/consul/pagination";

const props = withDefaults(defineProps<{ total: number; page: number; pageSize: number; compact?: boolean }>(), {
  compact: false,
});
const emit = defineEmits<{ "update:page": [page: number] }>();
const { t } = useI18n();
const pages = computed(() => consulPageCount(props.total, props.pageSize));
const current = computed(() => clampConsulPage(props.page, props.total, props.pageSize));
const status = computed(() => t("consul.ui.pageStatus", { page: current.value, pages: pages.value, total: props.total }));

function move(delta: number) {
  emit("update:page", clampConsulPage(current.value + delta, props.total, props.pageSize));
}
</script>

<template>
  <div v-if="pages > 1" class="flex shrink-0 items-center justify-center gap-1 text-xs text-muted-foreground" :title="status">
    <Button size="icon" variant="ghost" class="h-7 w-7" :disabled="current <= 1" :title="t('consul.ui.previousPage')" @click="move(-1)">
      <ChevronLeft class="h-3.5 w-3.5" />
    </Button>
    <span class="min-w-12 whitespace-nowrap text-center tabular-nums">{{ compact ? `${current} / ${pages}` : status }}</span>
    <Button size="icon" variant="ghost" class="h-7 w-7" :disabled="current >= pages" :title="t('consul.ui.nextPage')" @click="move(1)">
      <ChevronRight class="h-3.5 w-3.5" />
    </Button>
  </div>
</template>
