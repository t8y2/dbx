<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BINARY_CELL_TEXT_ENCODINGS, binaryCellTextPreview, type BinaryCellTextEncoding } from "@/lib/dataGrid/binaryCellDownload";
import type { DatabaseType } from "@/types/database";

const props = defineProps<{
  /** 单元格原始值（binary canonical form `0x<hex>`），只读使用。 */
  value: unknown;
  columnType?: string;
  databaseType?: DatabaseType;
  /** 单元格身份，切换单元格时重置字符集选择并关闭弹窗。 */
  identity: string;
  /** 后端返回的值本身不完整（大值预览闸门）时不解码残缺 bytes。 */
  incomplete?: boolean;
}>();

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const encoding = ref<BinaryCellTextEncoding>("utf8");

// 只读 presentation：结果不回写 detail.value / rawValue，不进入编辑与提交路径。
const preview = computed(() => binaryCellTextPreview(props.value, encoding.value, props.columnType, props.databaseType, props.incomplete));
const decodedText = computed(() => (preview.value.ok ? preview.value.text : ""));
const byteLength = computed(() => (preview.value.ok ? preview.value.byteLength : 0));
const errorKey = computed(() => (preview.value.ok ? "" : `grid.binaryTextPreviewErrors.${preview.value.error}`));

watch(
  () => props.identity,
  () => {
    open.value = false;
    encoding.value = "utf8";
  },
  { flush: "sync" },
);

async function copyResult() {
  const result = preview.value;
  if (!result.ok) return;
  try {
    await copyToClipboard(result.text);
    toast(t("grid.cellValueCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline" size="sm" class="h-6 px-2 text-xs" @mousedown.prevent>{{ t("grid.binaryTextPreview") }}</Button>
    </DialogTrigger>
    <DialogContent class="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ t("grid.binaryTextPreviewTitle") }}</DialogTitle>
        <DialogDescription>{{ t("grid.binaryTextPreviewDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="text-muted-foreground">{{ t("grid.binaryTextPreviewEncoding") }}</span>
        <div class="flex items-center gap-1">
          <Button v-for="item in BINARY_CELL_TEXT_ENCODINGS" :key="item" :variant="encoding === item ? 'secondary' : 'outline'" size="sm" class="h-7 px-2 text-xs" @click="encoding = item">
            {{ t(`grid.binaryTextPreviewEncodings.${item}`) }}
          </Button>
        </div>
        <span v-if="!errorKey" class="text-muted-foreground">{{ t("grid.binaryTextPreviewByteCount", { count: byteLength }) }}</span>
      </div>
      <p v-if="errorKey" role="alert" class="text-xs text-destructive">{{ t(errorKey) }}</p>
      <template v-else>
        <div class="flex items-center justify-between gap-2 text-xs">
          <span>{{ t("grid.binaryTextPreviewResult") }}</span>
          <Button variant="outline" size="sm" class="h-6 text-xs" @click="copyResult">{{ t("grid.binaryTextPreviewCopy") }}</Button>
        </div>
        <textarea :value="decodedText" :aria-label="t('grid.binaryTextPreviewResult')" readonly class="dbx-data-grid-value-font h-64 min-h-24 w-full resize-y rounded border bg-muted/20 p-3 text-xs" spellcheck="false" />
      </template>
      <p class="text-xs text-muted-foreground">{{ t("grid.binaryTextPreviewOriginalHint") }}</p>
    </DialogContent>
  </Dialog>
</template>
