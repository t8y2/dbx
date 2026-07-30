<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";
import CommonOptions from "./CommonOptions.vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const addressTypes = computed(() => [
  { value: "line1", label: t("dataGenerate.addressTypes.line1") },
  { value: "line2", label: t("dataGenerate.addressTypes.line2") },
  { value: "full", label: t("dataGenerate.addressTypes.full") },
]);

const regions = computed(() => [
  { value: "us", label: t("dataGenerate.countries.us") },
  { value: "uk", label: t("dataGenerate.countries.uk") },
  { value: "cn", label: t("dataGenerate.countries.cnEnglish") },
  { value: "jp", label: t("dataGenerate.countries.jpEnglish") },
]);

if (!props.params.addressType) props.params.addressType = "line1";
if (!props.params.regions) props.params.regions = ["us"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const usStreets = ["Main St", "Oak Ave", "Elm Rd", "Park Blvd", "Lake Dr", "Hill St", "Washington Blvd", "2nd Ave", "3rd St", "Pine Ln"];
const ukStreets = ["Oxford Street", "Abbey Road", "Baker Street", "Piccadilly", "Downing Street", "Regent Street", "Bond Street"];
const cnStreets = ["No. 88, YuShuang Road", "No. 128, Nanjing West Road", "No. 56, RenMin Avenue", "No. 201, ZhongShan Road", "No. 77, ChangJiang Road"];
const jpStreets = ["1-1-1, Marunouchi", "2-3-1, Shibuya", "3-2-1, Ginza", "1-5-2, Shinjuku", "4-1-3, Umeda"];

const usApts = ["Apt #203", "Unit 5", "Suite 300", "#4B", "Floor 7"];
const ukApts = ["Flat 3", "Apartment 5B", "Studio 2", "Suite 12"];
const cnApts = ["Building A, Unit 301", "Room 202, Block B", "Unit 1105"];
const jpApts = ["Building #2, 3F", "Room 402", "Tower A, 15F"];

function toggleRegion(val: string) {
  if (!props.params.regions) props.params.regions = [];
  const idx = props.params.regions.indexOf(val);
  if (idx >= 0) props.params.regions.splice(idx, 1);
  else props.params.regions.push(val);
}

function generateAddress(type: string, region: string): string {
  const num = randInt(1, 9999);
  const streets: Record<string, string[]> = {
    us: usStreets,
    uk: ukStreets,
    cn: cnStreets,
    jp: jpStreets,
  };
  const apts: Record<string, string[]> = {
    us: usApts,
    uk: ukApts,
    cn: cnApts,
    jp: jpApts,
  };
  const list = streets[region] ?? usStreets;
  const aptList = apts[region] ?? usApts;
  if (type === "line1") {
    if (region === "cn" || region === "jp") return pick(list);
    return `${num} ${pick(list)}`;
  }
  if (type === "line2") return pick(aptList);
  // full
  if (region === "cn" || region === "jp") return `${randInt(1, 999)} ${pick(list)}, ${pick(aptList)}`;
  return `${num} ${pick(list)}, ${pick(aptList)}`;
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const regionsSelected = props.params.regions?.length ? props.params.regions : ["us"];
  const region = pick(regionsSelected);
  return generateAddress(props.params.addressType ?? "line1", region);
});

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ t("dataGenerate.typeLabel") }}</div>
      <div class="flex items-center gap-2 text-xs">
        <button v-for="a in addressTypes" :key="a.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.addressType || 'line1') === a.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.addressType = a.value">{{ a.label }}</button>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ t("dataGenerate.regionLabel") }}</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="r in regions" :key="r.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.regions ?? []).includes(r.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleRegion(r.value)">{{ r.label }}</button>
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
