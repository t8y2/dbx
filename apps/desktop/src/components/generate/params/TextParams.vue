<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const lorem =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur Excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum";

const previewVal = computed(() => {
  void previewKey.value;
  const min = props.params.minLength ?? 50;
  const max = props.params.maxLength ?? 500;
  const len = Math.floor(Math.random() * (max - min + 1)) + min;
  let txt = "";
  while (txt.length < len) {
    txt += lorem + " ";
  }
  return txt.slice(0, len);
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
        <Label class="text-muted-foreground">字符数</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="params.minLength" type="number" min="1" placeholder="50" class="h-7 w-20 text-xs" />
          <span class="text-muted-foreground">-</span>
          <Input v-model.number="params.maxLength" type="number" min="1" placeholder="500" class="h-7 w-20 text-xs" />
        </div>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-start gap-2 text-xs">
        <span class="text-muted-foreground shrink-0 mt-0.5">预览</span>
        <p :key="previewKey" class="font-mono text-xs leading-relaxed break-all">{{ previewVal }}</p>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto shrink-0 mt-0.5" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
  </div>
</template>
