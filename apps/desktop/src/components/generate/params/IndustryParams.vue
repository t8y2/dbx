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
  { value: "zh_hant", label: "繁體中文" },
  { value: "ja", label: "日本語" },
];

if (!props.params.languages) props.params.languages = ["en"];

const dataMap: Record<string, string[]> = {
  en: ["Technology", "Healthcare", "Finance", "Education", "Manufacturing", "Retail", "Media", "Energy", "Real Estate", "Transportation", "Telecommunications", "Agriculture", "Hospitality", "Pharmaceutical", "Automotive", "Logistics", "Construction", "Entertainment"],
  zh: ["科技", "医疗保健", "金融", "教育", "制造业", "零售", "媒体", "能源", "房地产", "交通运输", "电信", "农业", "酒店业", "制药", "汽车", "物流", "建筑", "娱乐"],
  zh_hant: ["科技", "醫療保健", "金融", "教育", "製造業", "零售", "媒體", "能源", "房地產", "交通運輸", "電信", "農業", "酒店業", "製藥", "汽車", "物流", "建築", "娛樂"],
  ja: ["テクノロジー", "医療", "金融", "教育", "製造業", "小売", "メディア", "エネルギー", "不動産", "運輸", "通信", "農業", "ホスピタリティ", "製薬", "自動車", "物流", "建設", "エンターテイメント"],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function toggleLang(val: string) {
  if (!props.params.languages) props.params.languages = [];
  const idx = props.params.languages.indexOf(val);
  if (idx >= 0) props.params.languages.splice(idx, 1);
  else props.params.languages.push(val);
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const langs = props.params.languages?.length ? props.params.languages : ["en"];
  const lang = pick(langs);
  return pick(dataMap[lang] ?? dataMap["en"]);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">语言选择</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="l in languages" :key="l.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.languages ?? []).includes(l.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleLang(l.value)">{{ l.label }}</button>
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
