<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const ipTypes = [
  { value: "ipv4", label: "IPv4", regex: "^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$" },
  { value: "ipv6", label: "IPv6", regex: "^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$" },
];

function generateIPv4(): string {
  return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function generateIPv6(): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(
      Math.floor(Math.random() * 65536)
        .toString(16)
        .padStart(4, "0"),
    );
  }
  return groups.join(":");
}

const previewKey = ref(0);
const currentRegex = computed(() => {
  const t = props.params.ipType ?? "ipv4";
  return ipTypes.find((x) => x.value === t)?.regex ?? "";
});
const previewVal = computed(() => {
  void previewKey.value;
  if (props.params.ipType === "ipv6") return generateIPv6();
  return generateIPv4();
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">IP地址类型</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="t in ipTypes" :key="t.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.ipType || 'ipv4') === t.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.ipType = t.value">{{ t.label }}</button>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-1">正则表达式</div>
      <div class="font-mono text-xs bg-background rounded border px-2 py-1 break-all">{{ currentRegex }}</div>
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
