<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const defaultDomains = "gmail.com\noutlook.com\nyahoo.com\nexample.com\ntest.org";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
const chars = "abcdefghijklmnopqrstuvwxyz0123456789";

function genName(): string {
  const len = Math.floor(Math.random() * 12) + 4;
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const domains = (props.params.emailDomains || defaultDomains)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (domains.length === 0) return "(无域名)";
  return `${genName()}@${pick(domains)}`;
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">域（Domain）列表</Label>
      <textarea v-model="params.emailDomains" rows="4" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" :placeholder="defaultDomains" />
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
