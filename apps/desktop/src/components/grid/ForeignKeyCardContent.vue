<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

// 卡片 HTML（已 sanitize）渲染在 Shadow DOM 中：模板里的 <style> 只作用于卡片本身，
// 主题 CSS 变量（--foreground 等）仍会从宿主继承进来。
const props = defineProps<{ html: string }>();

const host = ref<HTMLDivElement | null>(null);
let shadow: ShadowRoot | null = null;

const BASE_STYLE = `<style>:host{display:block;font-family:inherit;color:var(--foreground);line-height:1.45}img{max-width:100%}*{box-sizing:border-box}</style>`;

function render() {
  if (!host.value) return;
  shadow ??= host.value.attachShadow({ mode: "open" });
  shadow.innerHTML = BASE_STYLE + props.html;
}

onMounted(render);
watch(() => props.html, render);
</script>

<template>
  <div ref="host" data-foreign-key-card-content />
</template>
