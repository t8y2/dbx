<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const previewVal = computed(() => {
  void previewKey.value;
  let sh = 0,
    sm = 23;
  if (!props.params.allDay) {
    sh = parseInt(props.params.startTime ?? "00") || 0;
    sm = parseInt(props.params.endTime ?? "23") || 23;
  }
  const h = Math.floor(Math.random() * (sm - sh + 1)) + sh;
  const m = Math.floor(Math.random() * 60);
  const s = Math.floor(Math.random() * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
});

const previewKey = ref(0);
function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3 space-y-2">
      <div class="flex items-center gap-2 text-xs">
        <input id="tm-all-day" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.allDay" @change="params.allDay = !params.allDay" />
        <Label for="tm-all-day" class="text-muted-foreground">{{ t("dataGenerate.allDay") }}</Label>
      </div>
      <div v-if="!params.allDay" class="flex items-center gap-2 text-xs ml-5">
        <Label class="text-muted-foreground shrink-0">{{ t("dataGenerate.startTime") }}</Label>
        <input
          :value="params.startTime ?? ''"
          @change="
            (e: Event) => {
              (params as Record<string, unknown>).startTime = (e.target as HTMLInputElement).value;
            }
          "
          type="time"
          class="h-7 w-24 min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
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
          class="h-7 w-24 min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-xs outline-none transition-colors dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
        />
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
