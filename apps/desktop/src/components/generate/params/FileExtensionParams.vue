<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";
import CommonOptions from "./CommonOptions.vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const extensionCategoryMap: Record<string, string[]> = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".tiff"],
  document: [".txt", ".pdf", ".doc", ".docx", ".rtf", ".odt"],
  spreadsheet: [".xls", ".xlsx", ".csv", ".ods", ".tsv"],
  presentation: [".ppt", ".pptx", ".odp", ".key"],
  audio: [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"],
  video: [".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv"],
  code: [".js", ".ts", ".py", ".java", ".cpp", ".c", ".h", ".rs", ".go", ".rb", ".php"],
  archive: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"],
  web: [".html", ".htm", ".css", ".json", ".xml", ".yml", ".yaml"],
  database: [".db", ".sqlite", ".sql", ".mdb", ".accdb"],
};

const categoryLabels = computed<Record<string, string>>(() => Object.fromEntries((["image", "document", "spreadsheet", "presentation", "audio", "video", "code", "archive", "web", "database"] as const).map((key) => [key, t(`dataGenerate.extensionCategories.${key}`)])));

if (!props.params.extensionCategory) {
  props.params.extensionCategory = "image";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const exts = extensionCategoryMap[props.params.extensionCategory ?? "image"] ?? extensionCategoryMap.image;
  return pick(exts);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ t("dataGenerate.extensionType") }}</div>
      <select v-model="params.extensionCategory" class="w-full rounded border bg-background px-2 py-1 text-xs">
        <option v-for="(label, key) in categoryLabels" :key="key" :value="key">{{ label }}</option>
      </select>
      <div class="mt-2 text-xs text-muted-foreground">{{ t("dataGenerate.extensionList") }}</div>
      <div class="mt-1 flex flex-wrap gap-1">
        <span v-for="ext in extensionCategoryMap[params.extensionCategory || 'image'] || []" :key="ext" class="px-1.5 py-0.5 rounded bg-background border text-xs font-mono">{{ ext }}</span>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">{{ t("dataGenerate.preview") }}</span>
        <span :key="previewKey" class="font-mono text-sm">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
    <CommonOptions :params="params" />
  </div>
</template>
