<script setup lang="ts">
import { computed } from "vue";
import { Copy, TriangleAlert, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { toast } = useToast();

const props = withDefaults(
  defineProps<{
    message: string;
    variant?: "banner" | "centered" | "card";
    title?: string;
    dismissible?: boolean;
    copyMode?: "icon" | "label";
  }>(),
  {
    variant: "banner",
    dismissible: false,
    copyMode: "icon",
  },
);

const emit = defineEmits<{
  dismiss: [];
}>();

const displayTitle = computed(() => props.title ?? t("grid.queryError"));

async function copy() {
  try {
    await copyToClipboard(props.message);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}
</script>

<template>
  <!-- card: 卡片类报错信息面板 -->
  <div v-if="variant === 'card'" class="mx-3 my-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 shadow-sm shrink-0 select-text flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2 border-b border-destructive/20 pb-2">
      <div class="flex items-center gap-2 font-semibold text-xs text-destructive">
        <TriangleAlert class="h-4 w-4 text-destructive shrink-0" aria-hidden="true" />
        <span>{{ displayTitle }}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/15 hover:text-destructive" :aria-label="t('grid.copy')" @click.stop="copy">
          <Copy class="h-3 w-3" />
          {{ t("grid.copy") }}
        </Button>
        <Button v-if="dismissible" variant="ghost" size="icon-sm" class="h-6 w-6 text-destructive/70 hover:text-destructive hover:bg-destructive/15" :aria-label="t('grid.dismiss')" @click.stop="emit('dismiss')">
          <X class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
    <div class="max-h-40 min-h-[56px] overflow-y-auto rounded bg-background/80 dark:bg-background/50 border border-destructive/20 p-2.5 text-xs font-mono leading-relaxed text-destructive break-words whitespace-pre-wrap select-text cursor-text" @mousedown.stop @click.stop>
      {{ message }}
    </div>
  </div>

  <!-- banner: 紧凑内联横幅 -->
  <div v-else-if="variant === 'banner'" class="flex items-center gap-2 px-3 py-1.5 border-t bg-destructive/10 text-destructive text-xs shrink-0">
    <span class="flex-1 min-w-0 break-all">{{ message }}</span>
    <button v-if="copyMode === 'label'" type="button" class="shrink-0 hover:underline" :aria-label="t('grid.copy')" @click.stop="copy">
      {{ t("grid.copy") }}
    </button>
    <Button v-else variant="ghost" size="icon-sm" class="h-5 w-5 shrink-0 text-destructive/70 hover:text-destructive" :aria-label="t('grid.copy')" @click.stop="copy">
      <Copy class="h-3 w-3" />
    </Button>
    <button v-if="dismissible" type="button" class="shrink-0 hover:underline" @click.stop="emit('dismiss')">{{ t("grid.dismiss") }}</button>
  </div>

  <!-- centered: 居中占满 -->
  <div v-else class="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
    <TriangleAlert class="h-8 w-8 text-destructive/50" aria-hidden="true" />
    <div class="min-h-0 max-h-48 max-w-lg overflow-auto space-y-1 select-text text-destructive" @mousedown.stop @click.stop>
      <div class="text-sm font-medium">{{ displayTitle }}</div>
      <div class="text-xs break-all cursor-text text-destructive/80 select-text">{{ message }}</div>
    </div>
    <div class="shrink-0 flex flex-wrap items-center justify-center gap-2 text-foreground">
      <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click.stop="copy">
        <Copy class="h-3.5 w-3.5" />
        {{ t("grid.copy") }}
      </Button>
      <slot name="actions" />
    </div>
  </div>
</template>
