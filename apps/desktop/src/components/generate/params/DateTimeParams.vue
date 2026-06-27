<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

function parseLocalDate(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

const previewVal = computed(() => {
  void previewKey.value;
  const start = props.params.start ? parseLocalDate(props.params.start) : new Date("2020-01-01");
  const end = props.params.end ? parseLocalDate(props.params.end) : new Date();
  const d = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  if (!props.params.allDay) {
    return formatLocalDate(d);
  }
  const sh = parseInt(props.params.startTime ?? "00") || 0;
  const sm = parseInt(props.params.endTime ?? "23") || 23;
  const h = Math.floor(Math.random() * (sm - sh + 1)) + sh;
  const m = Math.floor(Math.random() * 60);
  const s = Math.floor(Math.random() * 60);
  return `${formatLocalDate(d)} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
});

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

function toggleWeekday(d: number) {
  if (!props.params.weekdays) props.params.weekdays = [];
  const idx = props.params.weekdays.indexOf(d);
  if (idx >= 0) props.params.weekdays.splice(idx, 1);
  else props.params.weekdays.push(d);
}

const previewKey = ref(0);
function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">{{ t("dataGenerate.startDate") }}</Label>
        <input
          :value="params.start ?? ''"
          @change="
            (e: Event) => {
              (params as Record<string, unknown>).start = (e.target as HTMLInputElement).value;
            }
          "
          type="date"
          class="h-7 w-full min-w-0 rounded-[6px] border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        />
      </div>
      <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs mt-2">
        <Label class="text-muted-foreground">{{ t("dataGenerate.endDate") }}</Label>
        <input
          :value="params.end ?? ''"
          @change="
            (e: Event) => {
              (params as Record<string, unknown>).end = (e.target as HTMLInputElement).value;
            }
          "
          type="date"
          class="h-7 w-full min-w-0 rounded-[6px] border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        />
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3 space-y-2">
      <div class="flex items-center gap-2 text-xs">
        <input id="dt-all-day" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.allDay" @change="params.allDay = !params.allDay" />
        <Label for="dt-all-day" class="text-muted-foreground">{{ t("dataGenerate.allDay") }}</Label>
      </div>
      <div v-if="params.allDay" class="flex items-center gap-2 text-xs ml-5">
        <Label class="text-muted-foreground shrink-0">{{ t("dataGenerate.startTime") }}</Label>
        <input
          :value="params.startTime ?? ''"
          @change="
            (e: Event) => {
              (params as Record<string, unknown>).startTime = (e.target as HTMLInputElement).value;
            }
          "
          type="time"
          class="h-7 w-24 min-w-0 rounded-[6px] border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        />
        <Label class="text-muted-foreground shrink-0">{{ t("dataGenerate.endTime") }}</Label>
        <input
          :value="params.endTime ?? ''"
          @change="
            (e: Event) => {
              (params as Record<string, unknown>).endTime = (e.target as HTMLInputElement).value;
            }
          "
          type="time"
          class="h-7 w-24 min-w-0 rounded-[6px] border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        />
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ t("dataGenerate.weekday") }}</div>
      <div class="flex items-center gap-2 text-xs">
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="!params.weekdayMode || params.weekdayMode === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.weekdayMode = 'all'">{{ t("dataGenerate.all") }}</button>
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.weekdayMode === 'weekday' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.weekdayMode = 'weekday'">{{ t("dataGenerate.weekdayOnly") }}</button>
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.weekdayMode === 'custom' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.weekdayMode = 'custom'">{{ t("dataGenerate.custom") }}</button>
      </div>
      <div v-if="params.weekdayMode === 'custom'" class="flex gap-1 mt-2">
        <button v-for="(_, i) in 7" :key="i" type="button" class="w-7 h-7 rounded text-xs border" :class="(params.weekdays ?? []).includes(i) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="toggleWeekday(i)">{{ weekdayLabels[i] }}</button>
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
  </div>
</template>
