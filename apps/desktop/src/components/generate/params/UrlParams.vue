<script setup lang="ts">
import { computed, ref } from "vue";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

if (!props.params.urlSubdomains) {
  props.params.urlSubdomains = "auth.\ndrive.\nimage.\nwww.\napi.\nmail.\nshop.\nblog.";
}
if (!props.params.urlTlds) {
  props.params.urlTlds = ".biz\n.co.jp\n.com\n.cn\n.org\n.net\n.io\n.dev\n.xyz";
}

const baseDomains = ["example", "test", "demo", "sample", "meyer80", "acme", "contoso", "fabrikam"];
const paths = ["ToysGames", "home", "about", "products", "login", "dashboard", "items", "search", "profile", "settings"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const subs = splitLines(props.params.urlSubdomains ?? "");
  const tlds = splitLines(props.params.urlTlds ?? "");
  const sub = subs.length ? pick(subs) : "www.";
  const tld = tlds.length ? pick(tlds) : ".com";
  const base = pick(baseDomains);
  const path = pick(paths);
  return `https://${sub}${base}${tld}/${path}`;
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">子域</Label>
      <textarea v-model="params.urlSubdomains" rows="4" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" placeholder="每行一个子域&#10;auth.&#10;www.&#10;api." />
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <Label class="text-xs text-muted-foreground mb-1 block">顶级域</Label>
      <textarea v-model="params.urlTlds" rows="4" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" placeholder="每行一个TLD&#10;.com&#10;.cn&#10;.io" />
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">预览</span>
        <span :key="previewKey" class="font-mono text-sm break-all">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
    <CommonOptions :params="params" />
  </div>
</template>
