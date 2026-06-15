<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

if (!props.params.pattern) {
  props.params.pattern = "([A-F]{2}[-]){2}([0-9]{4}[-])([A-Z])";
}

function randFromCharSet(charSet: string, n: number): string {
  return Array.from({ length: n }, () => charSet.charAt(Math.floor(Math.random() * charSet.length))).join("");
}

function literalFromPattern(pattern: string): string {
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
    return `${randFromCharSet("ABCDEF", 2)}-${randFromCharSet("ABCDEF", 2)}-${randFromCharSet("0123456789", 4)}-${randFromCharSet("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 1)}`;
  }
  return result;
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  return literalFromPattern(props.params.pattern ?? "");
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">正则表达式</Label>
      <input v-model="params.pattern" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="([A-F]{2}[-]){2}([0-9]{4}[-])([A-Z])" />
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
