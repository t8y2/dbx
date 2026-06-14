<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const dateFormats = [
  { value: "MM/YY", label: "MM/YY" },
  { value: "MM/YYYY", label: "MM/YYYY" },
  { value: "YYYY-MM", label: "YYYY-MM" },
];

if (!props.params.ccDateFormat) props.params.ccDateFormat = "MM/YY";
if (props.params.ccYearOffsetMin === undefined) props.params.ccYearOffsetMin = 0;
if (props.params.ccYearOffsetMax === undefined) props.params.ccYearOffsetMax = 5;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDate(month: number, year: number, fmt: string): string {
  const yy = year % 100;
  const yyyy = year;
  switch (fmt) {
    case "MM/YYYY":
      return `${pad2(month)}/${yyyy}`;
    case "YYYY-MM":
      return `${yyyy}-${pad2(month)}`;
    case "MM/YY":
    default:
      return `${pad2(month)}/${pad2(yy)}`;
  }
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const now = new Date();
  const yearBase = now.getFullYear();
  const month = randInt(1, 12);
  const year = yearBase + randInt(props.params.ccYearOffsetMin ?? 0, props.params.ccYearOffsetMax ?? 5);
  return formatDate(month, year, props.params.ccDateFormat ?? "MM/YY");
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">日期类型</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="f in dateFormats" :key="f.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.ccDateFormat || 'MM/YY') === f.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.ccDateFormat = f.value">{{ f.label }}</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">年份范围（相对于当前年的偏移量）</div>
      <div class="flex items-center gap-2 text-xs">
        <Label class="text-muted-foreground">最小</Label>
        <Input v-model.number="params.ccYearOffsetMin" type="number" class="h-6 w-20 text-xs" />
        <Label class="text-muted-foreground">最大</Label>
        <Input v-model.number="params.ccYearOffsetMax" type="number" class="h-6 w-20 text-xs" />
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
