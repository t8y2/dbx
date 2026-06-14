<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const regions = [
  { value: "us", label: "美国" },
  { value: "uk", label: "英国" },
  { value: "cn", label: "中国" },
  { value: "jp", label: "日本" },
  { value: "other", label: "其他" },
];

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function genCN(sep: boolean): string {
  const a = randInt(130, 199);
  const b = randInt(1000, 9999);
  const c = randInt(1000, 9999);
  return sep ? `${a}-${b}-${c}` : `${a}${b}${c}`;
}
function genUS(sep: boolean): string {
  const a = randInt(200, 999);
  const b = randInt(100, 999);
  const c = randInt(1000, 9999);
  return sep ? `(${a}) ${b}-${c}` : `+1${a}${b}${c}`;
}
function genUK(sep: boolean): string {
  const a = randInt(1000, 9999);
  const b = randInt(100000, 999999);
  return sep ? `${a} ${b}` : `+44${a}${b}`;
}
function genJP(sep: boolean): string {
  const a = randInt(10, 99);
  const b = randInt(1000, 9999);
  const c = randInt(1000, 9999);
  return sep ? `0${a}-${b}-${c}` : `+810${a}${b}${c}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const regs = props.params.phoneRegions?.length ? props.params.phoneRegions : ["cn"];
  const reg = pick(regs);
  const sep = !!props.params.phoneSeparator;
  const num = reg === "us" ? genUS(sep) : reg === "uk" ? genUK(sep) : reg === "jp" ? genJP(sep) : genCN(sep);
  const fmt = props.params.phoneFormat ?? "domestic";
  return fmt === "international" && reg === "cn" ? `+86${num.replace(/[^0-9]/g, "")}` : num;
});

function toggleRegion(val: string) {
  if (!props.params.phoneRegions) props.params.phoneRegions = [];
  const idx = props.params.phoneRegions.indexOf(val);
  if (idx >= 0) props.params.phoneRegions.splice(idx, 1);
  else props.params.phoneRegions.push(val);
}

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">格式</div>
      <div class="flex items-center gap-2 text-xs">
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="(params.phoneFormat || 'domestic') === 'domestic' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.phoneFormat = 'domestic'">国内</button>
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.phoneFormat === 'international' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.phoneFormat = 'international'">国际</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <input id="phone-sep" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.phoneSeparator" @change="params.phoneSeparator = !params.phoneSeparator" />
        <Label for="phone-sep" class="text-muted-foreground">包含分隔符</Label>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">地区选择</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="r in regions" :key="r.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.phoneRegions ?? []).includes(r.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleRegion(r.value)">{{ r.label }}</button>
      </div>
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
