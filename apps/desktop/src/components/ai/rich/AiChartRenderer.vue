<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Copy, Download } from "@lucide/vue";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart, BarChart, PieChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, TitleComponent } from "echarts/components";
import VChart from "vue-echarts";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useI18n } from "vue-i18n";
import type { AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";
import { buildAiChartOption } from "@/lib/ai/richContent/aiChartOption";

// Module-level `use([...])` is idempotent, so re-importing this component
// alongside QueryChart.vue is safe.
use([CanvasRenderer, LineChart, BarChart, PieChart, AriaComponent, DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, TitleComponent]);

const props = defineProps<{
  spec: AiChartSpec;
  /** Preserve the model's original JSON for copy and inspect-data affordances. */
  content: string;
}>();

const { isDark } = useTheme();
const { t } = useI18n();
const { toast } = useToast();
const chartRef = ref<{ $el?: HTMLElement } | null>(null);
const copied = ref(false);
const formattedData = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.content), null, 2);
  } catch {
    return props.content;
  }
});

async function copyChartJson() {
  try {
    await copyToClipboard(props.content);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    // Keep the chart usable if the host denies clipboard access.
  }
}

// Match the card chrome around the chart (light zinc-50 / dark zinc-900) so a
// dark-theme PNG with light text stays readable on white viewers.
const pngBackground = computed(() => (isDark.value ? "#18181b" : "#fafafa"));

// `canvas.toBlob` encodes the transparent ECharts canvas as-is, which yields an
// unreadable PNG in dark mode. Compose the export onto an opaque theme-matching
// background first: paint a filled rect on an offscreen canvas, then draw the
// chart canvas over it.
function canvasToOpaquePng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const width = Math.max(1, Math.ceil(canvas.width));
    const height = Math.max(1, Math.ceil(canvas.height));
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.fillStyle = pngBackground.value;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0);
    offscreen.toBlob(resolve, "image/png");
  });
}

async function downloadPng() {
  const canvas = chartRef.value?.$el?.querySelector("canvas");
  if (!canvas) return;
  let blob: Blob | null;
  try {
    blob = await canvasToOpaquePng(canvas);
  } catch {
    toast(t("ai.chartDownloadFailed"));
    return;
  }
  if (!blob) {
    toast(t("ai.chartDownloadFailed"));
    return;
  }

  try {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "dbx-ai-chart.png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return;
    }

    // Browser fallback: object URLs avoid the size and lifecycle limitations of
    // canvas data URLs while preserving the same PNG output.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dbx-ai-chart.png";
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    toast(t("ai.chartDownloadFailed"));
  }
}
</script>

<template>
  <!-- Responsive non-zero height: `min-h-60` (240px) floors the chart inside the
       auto-height message stream, `clamp(15rem,35vw,20rem)` scales it with the
       panel up to 320px, and `autoresize` tracks panel resizes. vue-echarts owns
       `.echarts { height: 100% }`, so its parent—not the VChart element—must
       establish this viewport or the canvas resolves to 0px high. -->
  <section class="my-2 flex min-h-60 h-[clamp(15rem,35vw,20rem)] flex-col overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700/50 dark:bg-zinc-900" aria-label="AI-generated chart">
    <div class="flex h-8 items-center justify-end gap-1 border-b border-zinc-200 px-2 dark:border-zinc-700/50">
      <button type="button" class="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100" :title="copied ? t('ai.copied') : t('ai.copyCode')" :aria-label="copied ? t('ai.copied') : t('ai.copyCode')" @click="copyChartJson">
        <Check v-if="copied" class="h-3.5 w-3.5 text-green-500" />
        <Copy v-else class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100" :title="t('ai.chartDownloadPng')" :aria-label="t('ai.chartDownloadPng')" @click="downloadPng">
        <Download class="h-3.5 w-3.5" />
      </button>
    </div>
    <div class="min-h-0 flex-1">
      <VChart ref="chartRef" :option="buildAiChartOption(props.spec, { isDark })" autoresize class="h-full w-full p-2" />
    </div>
  </section>
  <details class="mb-2 rounded-md border border-zinc-200 text-xs dark:border-zinc-700/50">
    <summary class="cursor-pointer px-3 py-1.5 text-zinc-600 dark:text-zinc-300">{{ t("ai.chartData") }}</summary>
    <pre class="max-h-48 overflow-auto border-t border-zinc-200 p-3 text-[11px] dark:border-zinc-700/50">{{ formattedData }}</pre>
  </details>
</template>
