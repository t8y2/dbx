<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import { randInt, randDecimal } from "@/lib/dataGenerate";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const previewVal = computed(() => {
  void previewKey.value;
  const p = props.params;
  const min = p.min ?? 1;
  const max = p.max ?? 1000;
  if (p.numberType === "decimal") {
    return randDecimal(min, max, p.decimalPlaces ?? 2).toString();
  }
  return randInt(min, max).toString();
});

const isDecimal = computed(() => props.params.numberType === "decimal");

function handleTypeChange(val: "integer" | "decimal") {
  props.params.numberType = val;
  if (val === "integer") delete props.params.decimalPlaces;
  else props.params.decimalPlaces = props.params.decimalPlaces ?? 2;
}

const previewKey = ref(0);
function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">{{ t("dataGenerate.min") }}</Label>
        <Input v-model.number="params.min" type="number" placeholder="1" class="h-7 text-xs" />
      </div>
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs mt-2">
        <Label class="text-muted-foreground">{{ t("dataGenerate.max") }}</Label>
        <Input v-model.number="params.max" type="number" placeholder="1000" class="h-7 text-xs" />
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-3 text-xs">
        <Label class="text-muted-foreground shrink-0">数字类型</Label>
        <div class="flex gap-2">
          <button type="button" class="px-2 py-1 rounded text-xs border" :class="params.numberType !== 'decimal' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="handleTypeChange('integer')">整数</button>
          <button type="button" class="px-2 py-1 rounded text-xs border" :class="params.numberType === 'decimal' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="handleTypeChange('decimal')">小数</button>
        </div>
      </div>
      <div v-if="isDecimal" class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs mt-2">
        <Label class="text-muted-foreground">小数位数</Label>
        <Input v-model.number="params.decimalPlaces" type="number" min="0" max="10" class="h-7 w-20 text-xs" />
      </div>
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
  </div>
</template>
