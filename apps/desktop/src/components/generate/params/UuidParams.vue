<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

function genUuid(hyphens: boolean): string {
  const hex = "0123456789abcdef";
  const parts = [8, 4, 4, 4, 12];
  const uuid = parts.map((len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  });
  return hyphens ? uuid.join("-") : uuid.join("");
}

const previewVal = computed(() => {
  void previewKey.value;
  return genUuid(props.params.uuidHyphens !== false);
});
const regex = computed(() => (props.params.uuidHyphens !== false ? "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" : "^[0-9a-f]{32}$"));

const previewKey = ref(0);
function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">UUID格式</div>
      <div class="flex items-center gap-2 text-xs">
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.uuidHyphens !== false ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.uuidHyphens = true">包含连字符</button>
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.uuidHyphens === false ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.uuidHyphens = false">无格式</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-1">正则表达式</div>
      <code class="block text-xs font-mono bg-background rounded px-2 py-1 break-all">{{ regex }}</code>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">预览</span>
        <span :key="previewKey" class="font-mono text-sm break-all">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto shrink-0" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
  </div>
</template>
