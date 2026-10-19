<script setup lang="ts">
import { h, type CSSProperties, type VNode } from "vue";
import { Pin, X } from "@lucide/vue";
import { isTabDragImage, type TabDragAppearance, type TabDragVisual } from "@/lib/tabs/tabDragAppearance";

// 只负责展示；重命名、只读操作及标签行为由标签栏的插槽和事件承接。
defineProps<{
  title?: string;
  dirty?: boolean;
  collapsed?: boolean;
  pinned?: boolean;
  titleStyle?: CSSProperties;
  closeLabel?: string;
  unpinLabel?: string;
  preview?: TabDragAppearance;
}>();
defineEmits<{ close: []; unpin: [] }>();

function renderVisual(part: TabDragVisual): VNode {
  const style = { ...part.style, pointerEvents: "none" };
  if (part.image && isTabDragImage(part.image)) return h("img", { src: part.image, alt: "", draggable: false, style });
  return h("span", { style }, part.children?.map(renderVisual) ?? part.text ?? "");
}
const PreviewPart = (props: { part: TabDragVisual }) => renderVisual(props.part);
</script>

<template>
  <template v-if="preview">
    <PreviewPart v-for="(part, index) in preview.parts" :key="index" :part="part" />
  </template>
  <template v-else>
    <slot name="icon" />
    <span v-if="collapsed && dirty" data-tab-label-part="dirty" class="compact-dirty-tab-marker" aria-hidden="true" />
    <slot name="title">
      <span v-if="!collapsed" data-tab-label-part="title" class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-foreground">
        <span v-if="dirty" aria-hidden="true" class="dirty-tab-marker">*</span>
        <span class="min-w-0 flex-1 truncate" :style="titleStyle">{{ title }}</span>
      </span>
    </slot>
    <span v-if="!collapsed" data-tab-label-part="readonly" class="contents"><slot name="readonly" /></span>
    <button v-if="pinned && !collapsed" data-tab-label-part="pin" class="rounded p-0.5 text-primary hover:bg-muted-foreground/20 shrink-0" :aria-label="unpinLabel" :title="unpinLabel" @pointerdown.stop @click.stop="$emit('unpin')">
      <Pin class="h-3 w-3 fill-current" aria-hidden="true" />
    </button>
    <button v-if="!collapsed" data-tab-label-part="close" class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" :aria-label="closeLabel" :title="closeLabel" @pointerdown.stop @click.stop="$emit('close')">
      <X class="h-3 w-3" />
    </button>
  </template>
</template>
