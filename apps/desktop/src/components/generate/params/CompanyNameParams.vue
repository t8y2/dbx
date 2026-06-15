<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const languageOptions = [
  { value: "en", label: "English" },
  { value: "zh_pinyin", label: "Chinese (Pinyin)" },
  { value: "zh_eng", label: "Chinese (Eng)" },
  { value: "zh_hans", label: "Chinese (简体中文)" },
  { value: "ja_romaji", label: "Japanese (Romaji)" },
  { value: "ja", label: "Japanese (日本語)" },
];

if (!props.params.languages) props.params.languages = ["en"];

const prefixes: Record<string, string[]> = {
  en: ["Alpha", "Beta", "Global", "Prime", "Apex", "Nexus", "Atlas", "Vertex", "Zenith", "Acme", "Initech", "Globex", "Soylent"],
  zh_pinyin: ["Hua", "Zhong", "Da", "Xin", "Guo", "Tai", "Sheng", "Long", "Dong", "Nan"],
  zh_eng: ["Hua", "Zhong", "Da", "Xin", "Great", "New", "China", "Oriental", "Pacific", "Golden"],
  zh_hans: ["华", "中", "大", "新", "国", "泰", "盛", "龙", "东方", "金"],
  ja_romaji: ["Abe", "Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura", "Kobayashi"],
  ja: ["アベ", "サトウ", "スズキ", "タカハシ", "タナカ", "ワタナベ", "イトウ", "ヤマモト"],
};

const middles: Record<string, string[]> = {
  en: ["Consulting", "Technologies", "Solutions", "Enterprises", "Industries", "Systems", "Holdings", "Services", "Digital", "Media"],
  zh_pinyin: ["Keji", "Shangmao", "Gongcheng", "Fuwu", "Zixun", "Chuangxin", "Touzi", "Wenhua", "Dianzi", "Jiadian"],
  zh_eng: ["Tech", "Trading", "Industry", "Services", "Consulting", "Investment", "Digital", "Media", "Enterprise", "Group"],
  zh_hans: ["科技", "商贸", "工程", "服务", "咨询", "创新", "投资", "文化", "电子", "集团"],
  ja_romaji: ["Kigyo", "Sangyo", "Service", "Tech", "Consulting", "Media", "Digital", "System", "Network", "Holding"],
  ja: ["企業", "産業", "サービス", "テック", "コンサルティング", "メディア", "デジタル"],
};

const suffixes: Record<string, string[]> = {
  en: ["Inc.", "Ltd.", "Corporation", "Company", "LLC", "Group", "PLC", "Co."],
  zh_pinyin: ["Gongsi", "Jituan", "Gufen youxian gongsi", "Youxian gongsi"],
  zh_eng: ["Co., Ltd.", "Inc.", "Ltd.", "Corporation", "Group", "LLC"],
  zh_hans: ["有限公司", "股份有限公司", "集团", "公司"],
  ja_romaji: ["K.K.", "Kabushiki-gaisha", "G.K.", "Co., Ltd."],
  ja: ["株式会社", "合同会社", "有限会社"],
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
  const pf = prefixes[lang] ?? prefixes["en"];
  const md = middles[lang] ?? middles["en"];
  const sf = suffixes[lang] ?? suffixes["en"];
  return `${pick(pf)} ${pick(md)} ${pick(sf)}`.trim();
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
