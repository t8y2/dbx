<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { ArrowDownToLine, Trash2, X } from "lucide-vue-next";
import { translate } from "./i18n.js";
const props = defineProps({ entries: { type: Array, default: () => [] }, locale: { type: String, default: "zh-CN" } });
const t = (text) => translate(props.locale, text);
defineEmits(["close"]);
const level = ref("all"),
  follow = ref(true),
  cleared = ref(0),
  viewport = ref();
const visible = computed(() => props.entries.filter((e) => e.id > cleared.value && (level.value === "all" || e.level === level.value)));
function clear() {
  cleared.value = props.entries.at(-1)?.id || 0;
}
watch(
  [visible, follow],
  async () => {
    if (follow.value) {
      await nextTick();
      viewport.value?.scrollTo({ top: viewport.value.scrollHeight });
    }
  },
  { immediate: true },
);
</script>

<template>
  <section id="debug-panel" :aria-label="t('调试信息')" class="flex h-64 max-h-[40vh] min-h-0 shrink-0 flex-col border-t border-base-300 bg-base-200">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-base-300 px-3 py-2">
      <h2 class="mr-auto text-xs font-semibold">
        {{ t("调试信息") }}<span class="ml-2 font-normal text-base-content/60">{{ visible.length }} / 500</span>
      </h2>
      <select v-model="level" :aria-label="t('日志级别')" class="select select-xs w-32">
        <option value="all">{{ t("全部级别") }}</option>
        <option value="error">{{ t("错误") }}</option>
        <option value="info">{{ t("信息") }}</option>
        <option value="debug">{{ t("调试") }}</option>
      </select>
      <button class="btn btn-xs btn-square btn-ghost" :class="follow ? 'btn-active' : ''" :aria-pressed="follow" :aria-label="t('自动滚动')" :title="t('自动滚动')" @click="follow = !follow"><ArrowDownToLine :size="14" /></button>
      <button class="btn btn-xs btn-square btn-ghost" :aria-label="t('清空调试信息')" :title="t('清空当前视图')" @click="clear"><Trash2 :size="14" /></button>
      <button class="btn btn-xs btn-square btn-ghost" :aria-label="t('关闭调试信息')" :title="t('关闭调试信息')" @click="$emit('close')"><X :size="14" /></button>
    </div>
    <div ref="viewport" class="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-xs" role="log" aria-live="off" tabindex="0">
      <div v-for="entry in visible" :key="entry.id" class="flex flex-wrap gap-x-3 border-b border-base-300/50 py-1.5" :class="entry.level === 'error' ? 'text-error' : ''">
        <time class="shrink-0 text-base-content/60" :datetime="entry.time">{{ new Date(entry.time).toLocaleTimeString(locale, { hour12: false }) }}</time>
        <span class="w-12 shrink-0 uppercase">{{ entry.level }}</span>
        <span class="w-14 shrink-0 text-base-content/60">{{ entry.category }}</span>
        <div class="min-w-0 flex-1 break-words">
          <span>{{ t(entry.message) }}</span>
          <span class="ml-2 text-base-content/60">{{
            Object.entries(entry.details)
              .filter(([k]) => !["params", "result", "error"].includes(k))
              .map(([k, v]) => `${k}=${v}`)
              .join(" · ")
          }}</span>
          <details v-for="key in ['params', 'result', 'error'].filter((k) => k in entry.details)" :key="key" class="mt-1">
            <summary class="cursor-pointer text-info">{{ t({ params: "入参", result: "出参", error: "错误详情" }[key]) }}</summary>
            <pre class="mt-1 whitespace-pre-wrap break-all text-base-content">{{ JSON.stringify(entry.details[key], null, 2) }}</pre>
          </details>
        </div>
      </div>
      <p v-if="!visible.length" class="py-4 text-center text-base-content/50">{{ t("暂无调试记录") }}</p>
    </div>
  </section>
</template>
