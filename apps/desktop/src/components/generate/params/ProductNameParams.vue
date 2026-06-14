<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

if (!props.params.productKeywords) {
  props.params.productKeywords = "Apple\nCherry\nOrange\nMango\nBanana\nLemon\nGrape\nPeach\nPear\nMelon";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jumbleWord(word: string): string {
  const letters = word.split("");
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters.join("");
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const keywords = (props.params.productKeywords ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (keywords.length === 0) return "(无)";
  const mode = Math.random();
  if (mode < 0.4) {
    return pick(keywords);
  } else if (mode < 0.7) {
    return `${pick(keywords)} ${pick(keywords)}`;
  } else {
    return jumbleWord(pick(keywords).toLowerCase());
  }
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">使用关键字生成</Label>
      <textarea v-model="params.productKeywords" rows="6" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" placeholder="每行一个关键字&#10;Apple&#10;Cherry&#10;Orange" />
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
