<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const formats = [
  { value: "name", label: "名称" },
  { value: "code", label: "代码" },
  { value: "code_name", label: "代码+名称" },
];

const textTransforms = [
  { value: "none", label: "原样" },
  { value: "upper", label: "全大写" },
  { value: "lower", label: "全小写" },
  { value: "title", label: "每个单词首字母大写" },
];

const regionData = [
  { code: "US", en: "United States", zh: "美国", zh_hant: "美國", ja: "アメリカ合衆国" },
  { code: "CN", en: "China", zh: "中国", zh_hant: "中國", ja: "中国" },
  { code: "JP", en: "Japan", zh: "日本", zh_hant: "日本", ja: "日本" },
  { code: "GB", en: "United Kingdom", zh: "英国", zh_hant: "英國", ja: "イギリス" },
  { code: "DE", en: "Germany", zh: "德国", zh_hant: "德國", ja: "ドイツ" },
  { code: "FR", en: "France", zh: "法国", zh_hant: "法國", ja: "フランス" },
  { code: "CA", en: "Canada", zh: "加拿大", zh_hant: "加拿大", ja: "カナダ" },
  { code: "AU", en: "Australia", zh: "澳大利亚", zh_hant: "澳洲", ja: "オーストラリア" },
  { code: "IN", en: "India", zh: "印度", zh_hant: "印度", ja: "インド" },
  { code: "BR", en: "Brazil", zh: "巴西", zh_hant: "巴西", ja: "ブラジル" },
  { code: "RU", en: "Russia", zh: "俄罗斯", zh_hant: "俄羅斯", ja: "ロシア" },
  { code: "KR", en: "South Korea", zh: "韩国", zh_hant: "韓國", ja: "韓国" },
  { code: "IT", en: "Italy", zh: "意大利", zh_hant: "意大利", ja: "イタリア" },
  { code: "ES", en: "Spain", zh: "西班牙", zh_hant: "西班牙", ja: "スペイン" },
  { code: "MX", en: "Mexico", zh: "墨西哥", zh_hant: "墨西哥", ja: "メキシコ" },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function transformText(text: string, mode: string): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  if (mode === "title") return text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return text;
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const region = pick(regionData);
  const lang = props.params.regionLang ?? "en";
  const fmt = props.params.regionFormat ?? "name";
  const tf = props.params.textTransform ?? "none";
  let text = "";
  if (fmt === "code") text = region.code;
  else if (fmt === "code_name") text = `${region.code} - ${(region as any)[lang] ?? region.en}`;
  else text = (region as any)[lang] ?? region.en;
  return transformText(text, tf);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">格式</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="f in formats" :key="f.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.regionFormat || 'name') === f.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.regionFormat = f.value">{{ f.label }}</button>
      </div>
    </div>
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
          :class="(params.regionLang || 'en') === l.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'"
          @click="params.regionLang = l.value"
        >
          {{ l.label }}
        </button>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">将值转换为</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="t in textTransforms" :key="t.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.textTransform || 'none') === t.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.textTransform = t.value">
          {{ t.label }}
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
