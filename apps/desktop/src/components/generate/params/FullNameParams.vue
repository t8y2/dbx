<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const nameFormats: Array<{ value: "full" | "last" | "first"; label: string }> = [
  { value: "full", label: "全名" },
  { value: "last", label: "仅姓氏" },
  { value: "first", label: "仅名字" },
];

const languageOptions = [
  { value: "en", label: "English" },
  { value: "zh_pinyin", label: "Chinese (Pinyin)" },
  { value: "zh_hans", label: "Chinese (简体中文)" },
  { value: "zh_eng", label: "Chinese (Eng)" },
  { value: "zh_hant", label: "Chinese (繁体中文)" },
  { value: "ja_romaji", label: "Japanese (Romaji)" },
  { value: "ja", label: "Japanese (日本語)" },
];

function formatName(first: string, last: string, lang: string): string {
  const cjkNative = new Set(["zh_hans", "zh_hant", "ja"]);
  const cjkRomanized = new Set(["zh_pinyin", "ja_romaji"]);
  if (cjkNative.has(lang)) return `${last}${first}`;
  if (cjkRomanized.has(lang)) return `${last} ${first}`;
  return `${first} ${last}`;
}

const firstNames: Record<string, string[]> = {
  en: ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth"],
  zh_hans: ["伟", "芳", "娜", "秀英", "敏", "静", "丽", "强", "磊", "洋"],
  zh_hant: ["偉", "芳", "娜", "秀英", "敏", "靜", "麗", "強", "磊", "洋"],
  ja: ["翼", "桜", "翔太", "美咲", "蓮", "結菜", "大輔", "陽子"],
};
const lastNames: Record<string, string[]> = {
  en: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"],
  zh_hans: ["王", "李", "张", "刘", "陈", "杨", "赵", "黄"],
  zh_hant: ["王", "李", "張", "劉", "陳", "楊", "趙", "黃"],
  ja: ["佐藤", "鈴木", "高橋", "田中", "渡辺"],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const langs = props.params.languages?.length ? props.params.languages : ["en"];
  const lang = pick(langs);
  const fn = firstNames[lang] ?? firstNames["en"];
  const ln = lastNames[lang] ?? lastNames["en"];
  const fmt = props.params.nameFormat ?? "full";
  const first = pick(fn);
  const last = pick(ln);
  if (fmt === "first") return first;
  if (fmt === "last") return last;
  return formatName(first, last, lang);
});

function toggleLang(val: string) {
  if (!props.params.languages) props.params.languages = [];
  const idx = props.params.languages.indexOf(val);
  if (idx >= 0) props.params.languages.splice(idx, 1);
  else props.params.languages.push(val);
}

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">格式类型</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="f in nameFormats" :key="f.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.nameFormat || 'full') === f.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.nameFormat = f.value">{{ f.label }}</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">语言选择</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="l in languageOptions" :key="l.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.languages ?? []).includes(l.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleLang(l.value)">{{ l.label }}</button>
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
