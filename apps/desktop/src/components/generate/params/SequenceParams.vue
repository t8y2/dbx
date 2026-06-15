<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const previewVal = computed(() => {
  void previewKey.value;
  const s = props.params.startValue ?? 1;
  const inc = props.params.increment ?? 1;
  return Array.from({ length: 5 }, (_, i) => s + i * inc).join(", ") + ", ...";
});

const previewKey = ref(0);
function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">开始</Label>
        <Input v-model.number="params.startValue" type="number" placeholder="1" class="h-7 text-xs" />
      </div>
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs mt-2">
        <Label class="text-muted-foreground">{{ t("dataGenerate.increment") }}</Label>
        <Input v-model.number="params.increment" type="number" placeholder="1" class="h-7 text-xs" />
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">{{ t("dataGenerate.min") }}</Label>
        <Input v-model.number="params.sequenceMin" type="number" placeholder="-" class="h-7 text-xs" />
      </div>
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs mt-2">
        <Label class="text-muted-foreground">{{ t("dataGenerate.max") }}</Label>
        <Input v-model.number="params.sequenceMax" type="number" placeholder="-" class="h-7 text-xs" />
      </div>
      <div class="flex items-center gap-2 text-xs mt-2 ml-[88px]">
        <input id="seq-cycle" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.sequenceCycle" @change="params.sequenceCycle = !params.sequenceCycle" />
        <Label for="seq-cycle" class="text-muted-foreground">{{ t("dataGenerate.cycle") }}</Label>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">{{ t("dataGenerate.preview") }}</span>
        <span :key="previewKey" class="font-mono text-sm truncate">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto shrink-0" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
  </div>
</template>
