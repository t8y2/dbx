<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const p = props.params.pattern ?? "";
  if (!p) return "(未设置)";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  try {
    const regex = new RegExp("^" + p + "$");
    let attempt = "";
    for (let i = 0; i < 100; i++) {
      const len = p.includes("{") ? parseInt(p.match(/\{(\d+)/)?.[1] ?? "10") : 10;
      attempt = Array.from({ length: Math.min(len, 50) }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      if (regex.test(attempt)) return attempt;
    }
    return attempt || "(无法匹配)";
  } catch {
    return "(无效正则)";
  }
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">正则表达式</Label>
        <Input v-model="params.pattern" type="text" placeholder="[A-Za-z0-9]{10}" class="h-7 text-xs font-mono" />
      </div>
      <div class="flex items-center gap-2 text-xs mt-2">
        <input id="regex-raw" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.rawPattern" @change="params.rawPattern = !params.rawPattern" />
        <Label for="regex-raw" class="text-muted-foreground">原始数据模式</Label>
      </div>
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

    <CommonOptions :params="params" />
  </div>
</template>
