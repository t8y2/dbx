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

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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
  const item = cardTypes.find((c) => c.value === chosen);
  return item?.label ?? chosen;
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
