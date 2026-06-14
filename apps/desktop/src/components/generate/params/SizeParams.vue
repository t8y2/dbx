<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const dataMap: Record<string, string[]> = {
  en: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "One Size"],
  zh: ["特小", "小", "中", "大", "加大", "特大", "超特大", "均码"],
  zh_hant: ["特小", "小", "中", "大", "加大", "特大", "超特大", "均碼"],
  ja: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "フリーサイズ"],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const lang = props.params.languages?.[0] ?? "en";
  return pick(dataMap[lang] ?? dataMap["en"]);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">语言</div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="l in [
            { value: 'en', label: 'English' },
            { value: 'zh', label: '简体中文' },
            { value: 'zh_hant', label: '繁體中文' },
            { value: 'ja', label: '日本語' },
          ]"
          :key="l.value"
          type="button"
          class="px-2 py-1 rounded border text-xs"
          :class="(params.languages?.[0] || 'en') === l.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'"
          @click="params.languages = [l.value]"
        >
          {{ l.label }}
        </button>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">预览</span>
        <span :key="previewKey" class="font-mono text-sm">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
    <CommonOptions :params="params" />
  </div>
</template>
