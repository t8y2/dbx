<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const cardTypes = [
  { value: "american_express", label: "American Express" },
  { value: "jcb", label: "JCB" },
  { value: "mastercard", label: "MasterCard" },
  { value: "unionpay", label: "UnionPay" },
  { value: "visa", label: "Visa" },
];

if (!props.params.cardTypes) {
  props.params.cardTypes = ["visa", "mastercard"];
}

const prefixMap: Record<string, string[]> = {
  american_express: ["34", "37"],
  jcb: ["3528", "3529", "3530", "3531", "3532", "3533", "3534", "3535", "3536", "3537", "3538", "3539"],
  mastercard: ["51", "52", "53", "54", "55", "2221", "2222", "2223", "2224", "2225", "2226", "2227", "2228", "2229", "223", "224", "225", "226", "227", "228", "229", "23", "24", "25", "26", "270", "271", "2720"],
  unionpay: ["62", "623", "624", "625", "626", "627", "628", "622126", "622127", "622128", "622129", "622130"],
  visa: ["4"],
};

const lengthMap: Record<string, number> = {
  american_express: 15,
  jcb: 16,
  mastercard: 16,
  unionpay: 16,
  visa: 16,
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randDigit(): number {
  return Math.floor(Math.random() * 10);
}

function luhnCheck(numStr: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let d = parseInt(numStr.charAt(i), 10);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function generateLuhnCard(prefix: string, length: number): string {
  const body = prefix.split("").map((c) => parseInt(c, 10));
  while (body.length < length - 1) {
    body.push(randDigit());
  }
  for (let check = 0; check < 10; check++) {
    const candidate = body.join("") + String(check);
    if (luhnCheck(candidate)) return candidate;
  }
  return body.join("") + "0";
}

function toggleCardType(val: string) {
  if (!props.params.cardTypes) props.params.cardTypes = [];
  const idx = props.params.cardTypes.indexOf(val);
  if (idx >= 0) props.params.cardTypes.splice(idx, 1);
  else props.params.cardTypes.push(val);
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const selected = props.params.cardTypes?.length ? props.params.cardTypes : cardTypes.map((c) => c.value);
  const chosen = pick(selected);
  const prefix = pick(prefixMap[chosen] ?? ["4"]);
  const length = lengthMap[chosen] ?? 16;
  return generateLuhnCard(prefix, length);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">类型选择</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="c in cardTypes" :key="c.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.cardTypes ?? []).includes(c.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleCardType(c.value)">{{ c.label }}</button>
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
