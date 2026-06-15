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
    en: ["Software Engineer", "Senior Manager", "Product Designer", "Data Analyst", "DevOps Engineer", "HR Director", "Marketing Lead", "Human resources manager"],
    zh: ["软件工程师", "高级经理", "产品设计师", "数据分析师", "运维工程师", "人力资源总监", "市场主管", "项目经理"],
    zh_hant: ["軟體工程師", "高級經理", "產品設計師", "數據分析師", "運維工程師", "人力資源總監", "市場主管"],
    ja: ["ソフトウェアエンジニア", "シニアマネージャー", "プロダクトデザイナー", "データアナリスト", "人事部長", "マーケティング部長"],
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
