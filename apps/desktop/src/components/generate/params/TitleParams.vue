<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const languages = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "zh_hant", label: "繁体中文" },
  { value: "ja", label: "日本語" },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const lang = props.params.languages?.[0] ?? "en";
  const map: Record<string, string[]> = {
    en: ["Mr.", "Mrs.", "Miss", "Ms.", "Dr.", "Prof."],
    zh: ["先生", "女士", "小姐", "博士", "教授"],
    zh_hant: ["先生", "女士", "小姐", "博士", "教授"],
    ja: ["様", "殿", "先生", "博士"],
  };
  return pick(map[lang] ?? map["en"]);
});

function setLang(val: string) {
  props.params.languages = [val];
}

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">语言选择</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="l in languages" :key="l.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.languages?.[0] || 'en') === l.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="setLang(l.value)">{{ l.label }}</button>
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
