<script setup lang="ts">
import { computed } from "vue";
import { Copy, TriangleAlert } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { toast } = useToast();

const props = withDefaults(
  defineProps<{
    message: string;
    variant?: "banner" | "centered";
    title?: string;
  }>(),
  {
    variant: "banner",
  },
);

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
  <!-- banner: 紧凑内联横幅 -->
  <div v-if="variant === 'banner'" class="flex items-center gap-2 px-3 py-1.5 border-t bg-destructive/10 text-destructive text-xs shrink-0">
    <span class="flex-1 min-w-0 break-all">{{ message }}</span>
    <Button variant="ghost" size="icon-sm" class="h-5 w-5 shrink-0 text-destructive/70 hover:text-destructive" :aria-label="t('grid.copy')" @click.stop="copy">
      <Copy class="h-3 w-3" />
    </Button>
  </div>

  <!-- centered: 居中占满 -->
  <div v-else class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-destructive">
    <TriangleAlert class="h-8 w-8 text-destructive/50" aria-hidden="true" />
    <div class="space-y-1 select-text" @mousedown.stop @click.stop>
      <div class="text-sm font-medium">{{ displayTitle }}</div>
      <div class="text-xs max-w-lg break-all cursor-text text-destructive/80 select-text">{{ message }}</div>
    </div>
    <div class="flex flex-wrap items-center justify-center gap-2">
      <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click.stop="copy">
        <Copy class="h-3.5 w-3.5" />
        {{ t("grid.copy") }}
      </Button>
      <slot name="actions" />
    </div>
  </div>
</template>
