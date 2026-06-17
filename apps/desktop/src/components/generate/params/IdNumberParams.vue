<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const { t } = useI18n();

function tr(key: string, fallback: string): string {
  const v = t("dataGenerate.idTypes." + key);
  return v === "dataGenerate.idTypes." + key ? fallback : v;
}

const props = defineProps<{ params: GeneratorParams }>();

const idTypeKeys = ["id_card", "passport", "hk_macau_pass", "taiwan_pass", "uscc", "bank_card", "drivers_license", "custom"];

if (!props.params.idTypes) {
  props.params.idTypes = ["id_card"];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function toggleType(val: string) {
  if (!props.params.idTypes) props.params.idTypes = [];
  const idx = props.params.idTypes.indexOf(val);
  if (idx >= 0) props.params.idTypes.splice(idx, 1);
  else props.params.idTypes.push(val);
}

const hasCustom = computed(() => (props.params.idTypes ?? []).includes("custom"));

const areaCodes = [
  "110101",
  "110105",
  "110108",
  "120101",
  "120103",
  "130102",
  "130105",
  "210102",
  "210105",
  "210203",
  "310101",
  "310104",
  "310115",
  "320102",
  "320105",
  "330102",
  "330106",
  "340102",
  "340104",
  "350102",
  "360102",
  "370102",
  "370202",
  "410102",
  "410105",
  "420102",
  "420106",
  "430102",
  "440103",
  "440106",
  "440303",
  "440305",
  "450102",
  "460105",
  "500103",
  "510104",
  "510107",
  "520102",
  "530102",
  "540102",
  "610103",
  "620102",
  "630102",
  "640104",
  "650102",
];

function generateIdCard(): string {
  const area = pick(areaCodes);
  const year = (1970 + Math.floor(Math.random() * 35)).toString();
  const month = (Math.floor(Math.random() * 12) + 1).toString().padStart(2, "0");
  const day = (Math.floor(Math.random() * 28) + 1).toString().padStart(2, "0");
  const seq = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  const first17 = `${area}${year}${month}${day}${seq}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += parseInt(first17[i]) * weights[i];
  const check = checks[sum % 11];
  return `${first17}${check}`;
}

function randDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10).toString()).join("");
}

function generatePassport(): string {
  return `${pick(["E", "G", "E", "H", "P"])}${randDigits(7)}`;
}

function generateHKMacauPass(): string {
  return `${pick(["C", "W", "H"])}${randDigits(8)}`;
}

function generateTaiwanPass(): string {
  return `T${randDigits(8)}`;
}

function generateUSCC(): string {
  const randChars = (n: number) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXY23456789".charAt(Math.floor(Math.random() * "ABCDEFGHJKLMNPQRSTUVWXY23456789".length))).join("");
  return `91310115MA${randChars(6)}${randDigits(4)}`;
}

function luhnCalculateCheckDigit(numStr: string): string {
  let sum = 0;
  const digits = numStr.split("").map(Number);
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

function generateBankCard(): string {
  const bins = ["622202", "622700", "621700", "622848", "621559", "621798", "622208", "622280", "621661", "621785", "622588", "621286", "622696"];
  const bin = pick(bins);
  const middle = randDigits(10);
  const first15 = `${bin}${middle}`;
  return `${first15}${luhnCalculateCheckDigit(first15)}`;
}

function randFromCharSet(charSet: string, n: number): string {
  return Array.from({ length: n }, () => charSet.charAt(Math.floor(Math.random() * charSet.length))).join("");
}

function generateFromPattern(pattern: string): string {
  const letterCharSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digitCharSet = "0123456789";
  let result = "";
  const tokens = pattern.split(/([{}[\]-])/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "(" || t === ")") {
      i++;
      continue;
    }
    if (t === "[") {
      const charSetToken = tokens[i + 1];
      i += 2;
      let charSet = "";
      if (charSetToken?.includes("A-F") || charSetToken?.includes("A-Z")) charSet = letterCharSet;
      else if (charSetToken?.includes("0-9")) charSet = digitCharSet;
      else charSet = letterCharSet + digitCharSet;
      i++;
      let count = 1;
      if (tokens[i] === "{") {
        i++;
        count = parseInt(tokens[i], 10) || 1;
        i += 2;
      }
      result += randFromCharSet(charSet, count);
      continue;
    }
    if (t === "-") {
      result += "-";
      i++;
      continue;
    }
    i++;
  }
  if (!result) {
    return randDigits(10);
  }
  return result;
}

function generateByType(type: string): string {
  switch (type) {
    case "id_card":
      return generateIdCard();
    case "passport":
      return generatePassport();
    case "hk_macau_pass":
      return generateHKMacauPass();
    case "taiwan_pass":
      return generateTaiwanPass();
    case "uscc":
      return generateUSCC();
    case "bank_card":
      return generateBankCard();
    case "drivers_license":
      return generateIdCard();
    case "custom":
      return generateFromPattern(props.params.idCustomPattern ?? "([A-Z]{2})-([0-9]{8})");
    default:
      return generateIdCard();
  }
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const selected = props.params.idTypes?.length ? props.params.idTypes : ["id_card"];
  return generateByType(pick(selected));
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ tr("title", "证件类型") }}</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="k in idTypeKeys" :key="k" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.idTypes ?? []).includes(k) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleType(k)">{{ tr(k, k) }}</button>
      </div>
    </div>
    <div v-if="hasCustom" class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-1">{{ tr("customPattern", "自定义模式") }}</div>
      <input v-model="params.idCustomPattern" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono" :placeholder="tr('customPatternPlaceholder', '如 ([A-Z]{2})-([0-9]{8})')" />
      <div class="text-[10px] text-muted-foreground mt-1">{{ tr("customPatternHint", "支持 [A-Z] 字母、[0-9] 数字、{n} 重复、连字符等简单模式") }}</div>
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
