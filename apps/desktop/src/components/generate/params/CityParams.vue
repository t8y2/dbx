<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const regions = [
  { value: "us", label: "美国" },
  { value: "uk", label: "英国" },
  { value: "cn", label: "中国" },
  { value: "jp", label: "日本" },
];

const languages = [
  { value: "en", label: "English" },
  { value: "native", label: "本地语言" },
];

if (!props.params.regions) props.params.regions = ["us"];
if (!props.params.languages) props.params.languages = ["en"];

const cities: Record<string, { en: string; native: string }[]> = {
  us: [
    { en: "New York", native: "New York" },
    { en: "Los Angeles", native: "Los Angeles" },
    { en: "Chicago", native: "Chicago" },
    { en: "San Francisco", native: "San Francisco" },
    { en: "Boston", native: "Boston" },
    { en: "Seattle", native: "Seattle" },
    { en: "Washington, D.C.", native: "Washington, D.C." },
    { en: "Miami", native: "Miami" },
  ],
  uk: [
    { en: "London", native: "London" },
    { en: "Manchester", native: "Manchester" },
    { en: "Birmingham", native: "Birmingham" },
    { en: "Liverpool", native: "Liverpool" },
    { en: "Edinburgh", native: "Edinburgh" },
    { en: "Glasgow", native: "Glasgow" },
    { en: "Bristol", native: "Bristol" },
  ],
  cn: [
    { en: "Beijing", native: "北京" },
    { en: "Shanghai", native: "上海" },
    { en: "Guangzhou", native: "广州" },
    { en: "Shenzhen", native: "深圳" },
    { en: "Chengdu", native: "成都" },
    { en: "Hangzhou", native: "杭州" },
    { en: "Nanjing", native: "南京" },
    { en: "Xi'an", native: "西安" },
  ],
  jp: [
    { en: "Tokyo", native: "東京" },
    { en: "Osaka", native: "大阪" },
    { en: "Kyoto", native: "京都" },
    { en: "Yokohama", native: "横浜" },
    { en: "Nagoya", native: "名古屋" },
    { en: "Sapporo", native: "札幌" },
    { en: "Fukuoka", native: "福岡" },
  ],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function toggleRegion(val: string) {
  if (!props.params.regions) props.params.regions = [];
  const idx = props.params.regions.indexOf(val);
  if (idx >= 0) props.params.regions.splice(idx, 1);
  else props.params.regions.push(val);
}

function setLang(val: string) {
  props.params.languages = [val];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const regionsSelected = props.params.regions?.length ? props.params.regions : ["us"];
  const region = pick(regionsSelected);
  const city = pick(cities[region] ?? cities["us"]);
  const lang = props.params.languages?.[0] ?? "en";
  return lang === "native" ? city.native : city.en;
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">地区</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="r in regions" :key="r.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.regions ?? []).includes(r.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleRegion(r.value)">{{ r.label }}</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">语言</div>
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
