<script setup lang="ts">
import type { Translate } from "../docsWarnings";
import { groupStyle } from "../groupColor";
import type { GroupAnnotation } from "../types";

const props = defineProps<{
  group: GroupAnnotation;
  translate: Translate;
}>();

const emit = defineEmits<{
  "update:group": [group: GroupAnnotation];
  delete: [groupId: string];
}>();

/**
 * Twelve evenly spaced hues.
 *
 * Presets are hues, not colours: docs.css fixes lightness and chroma per
 * theme, so any point on the wheel is legible on both grounds and an even
 * split cannot produce a bad preset.
 */
const PRESET_HUES = Array.from({ length: 12 }, (_, step) => step * 30);

function rename(event: Event): void {
  emit("update:group", { ...props.group, name: (event.target as HTMLInputElement).value });
}

function recolour(hue: number): void {
  emit("update:group", { ...props.group, hue });
}

function slide(event: Event): void {
  recolour(Number((event.target as HTMLInputElement).value));
}

/**
 * No per-hue i18n key exists and adding one means eight locale files, so the
 * tooltip pairs the "Colour" label with the raw hue.
 */
function swatchTitle(hue: number): string {
  return `${props.translate("docs.groupColour")} ${hue}°`;
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ translate("docs.groupName") }}</span>
      <input type="text" :value="group.name" :placeholder="translate('docs.groupName')" class="rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring" @input="rename($event)" />
    </label>

    <div class="flex flex-col gap-2">
      <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ translate("docs.groupColour") }}</span>

      <!-- `docs-group` and the hue go on the SAME element: the class brings in
           the theme's lightness and chroma, groupStyle only supplies --h. A
           hex fill here could not stay legible on both grounds. -->
      <div class="flex items-center gap-1.5">
        <button
          v-for="hue in PRESET_HUES"
          :key="hue"
          type="button"
          class="docs-group h-6 w-6 rounded-full border ring-offset-background transition hover:scale-105"
          :class="group.hue === hue ? 'ring-2 ring-ring ring-offset-2' : 'border-border'"
          style="background-color: var(--group-c)"
          :style="groupStyle(hue)"
          :title="swatchTitle(hue)"
          @click="recolour(hue)"
        ></button>
      </div>

      <input type="range" min="0" max="359" :value="group.hue" class="w-full" :title="swatchTitle(group.hue)" @input="slide($event)" />

      <!-- Both grounds at once: the reader picks one hue and it has to work in
           either theme, so neither can be left to imagination. `docs-ground-light`
           and `dark` pin each half to a theme regardless of the app's own. -->
      <div class="grid grid-cols-2 gap-2">
        <div class="docs-ground-light flex items-center gap-2 overflow-hidden rounded border border-border bg-white p-2">
          <span class="docs-group h-4 w-4 shrink-0 rounded-full" style="background-color: var(--group-c)" :style="groupStyle(group.hue)"></span>
          <span class="docs-group truncate rounded px-1.5 py-0.5 text-[11px] font-medium" style="background-color: var(--group-tint); color: var(--group-c)" :style="groupStyle(group.hue)">{{ group.name }}</span>
        </div>
        <div class="dark flex items-center gap-2 overflow-hidden rounded border border-border bg-neutral-900 p-2">
          <span class="docs-group h-4 w-4 shrink-0 rounded-full" style="background-color: var(--group-c)" :style="groupStyle(group.hue)"></span>
          <span class="docs-group truncate rounded px-1.5 py-0.5 text-[11px] font-medium" style="background-color: var(--group-tint); color: var(--group-c)" :style="groupStyle(group.hue)">{{ group.name }}</span>
        </div>
      </div>
    </div>

    <div class="flex justify-end">
      <button type="button" class="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40" @click="emit('delete', group.id)">
        {{ translate("docs.deleteGroup") }}
      </button>
    </div>
  </div>
</template>
