<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";
import CommonOptions from "./CommonOptions.vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

if (!props.params.values) {
  props.params.values = "g\nkg\nlb\noz\nt\nmg\nct";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const vals = (props.params.values ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (vals.length === 0) return t("dataGenerate.noValue");
  return pick(vals);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">{{ t("dataGenerate.values") }}</Label>
      <textarea v-model="params.values" rows="5" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" :placeholder="t('dataGenerate.placeholders.weightUnits')" />
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
