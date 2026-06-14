<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const barcodeTypes = [
  { value: "ean8", label: "EAN8", regex: "[0-9]{8}" },
  { value: "ean13", label: "EAN13", regex: "[0-9]{13}" },
  { value: "upca", label: "UPCA", regex: "[0-9]{12}" },
  { value: "upce", label: "UPCE", regex: "[0-9]{6}" },
  { value: "isbn", label: "ISBN", regex: "[0-9]{13}" },
  { value: "code39", label: "Code39", regex: "[A-Z]{3}-[0-9]{4}" },
];

if (!props.params.barcodeTypes) {
  props.params.barcodeTypes = ["ean13"];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10).toString()).join("");
}

function generateByType(type: string): string {
  switch (type) {
    case "ean8":
      return randDigits(8);
    case "ean13":
      return randDigits(13);
    case "upca":
      return randDigits(12);
    case "upce":
      return randDigits(6);
    case "isbn":
      return `978${randDigits(10)}`;
    case "code39": {
      const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
      return `${letters}-${randDigits(4)}`;
    }
    default:
      return randDigits(13);
  }
}

function toggleBarcode(val: string) {
  if (!props.params.barcodeTypes) props.params.barcodeTypes = [];
  const idx = props.params.barcodeTypes.indexOf(val);
  if (idx >= 0) props.params.barcodeTypes.splice(idx, 1);
  else props.params.barcodeTypes.push(val);
}

const currentRegex = computed(() => {
  if (!props.params.barcodeTypes?.length) return "";
  const chosen = pick(props.params.barcodeTypes);
  const bt = barcodeTypes.find((b) => b.value === chosen);
  return bt?.regex ?? "";
});

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const selected = props.params.barcodeTypes?.length ? props.params.barcodeTypes : ["ean13"];
  return generateByType(pick(selected));
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">类型</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="b in barcodeTypes" :key="b.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.barcodeTypes ?? []).includes(b.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleBarcode(b.value)">{{ b.label }}</button>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-1">正则表达式</div>
      <div class="font-mono text-xs bg-background rounded border px-2 py-1 break-all">{{ currentRegex }}</div>
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
