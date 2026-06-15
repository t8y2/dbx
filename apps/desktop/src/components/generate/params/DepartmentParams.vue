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
  en: ["Engineering", "Marketing", "Sales", "Human Resources", "Finance", "Operations", "Research and Development", "Customer Support", "Legal", "IT", "Design", "Purchasing"],
  zh: ["研发部", "市场部", "销售部", "人力资源部", "财务部", "运营部", "研发中心", "客户支持部", "法务部", "信息技术部", "设计部", "采购部"],
  zh_hant: ["研發部", "市場部", "銷售部", "人力資源部", "財務部", "營運部", "研發中心", "客戶支援部", "法務部", "資訊技術部", "設計部", "採購部"],
  ja: ["エンジニアリング", "マーケティング", "営業", "人事", "経理", "オペレーション", "研究開発", "カスタマーサポート", "法務", "IT", "デザイン", "購買"],
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
