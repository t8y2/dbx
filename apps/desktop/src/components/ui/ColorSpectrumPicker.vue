<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { hexToHsv, hsvToHex } from "@/lib/common/color";

interface Props {
  modelValue: string;
  disabled?: boolean;
  /** Shown next to the live hex readout so a row can label what is being picked. */
  label?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const { t } = useI18n();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const spectrumRef = ref<HTMLElement | null>(null);
const hueRef = ref<HTMLElement | null>(null);
const hue = ref(0);
const saturation = ref(0);
const value = ref(0);
// Non-null only while the cursor is over a gradient, so the readout can track it
// without disturbing the committed color.
const previewHex = ref<string | null>(null);

const currentHex = computed(() => hsvToHex({ h: hue.value, s: saturation.value, v: value.value }));
// Hovering wins so the cursor can survey colors, otherwise show the pending pick.
const readoutHex = computed(() => previewHex.value ?? currentHex.value);

function syncFromModel() {
  const hsv = hexToHsv(props.modelValue);
  if (!hsv) return;
  // A greyscale color carries no usable hue, so keep the slider where the user left it.
  if (hsv.s > 0) hue.value = hsv.h;
  saturation.value = hsv.s;
  value.value = hsv.v;
}

watch(() => props.modelValue, syncFromModel, { immediate: true });

function ratioWithin(element: HTMLElement, event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function spectrumHexAt(event: PointerEvent | MouseEvent): string | null {
  if (!spectrumRef.value) return null;
  const { x, y } = ratioWithin(spectrumRef.value, event);
  return hsvToHex({ h: hue.value, s: x, v: 1 - y });
}

function hueHexAt(event: PointerEvent | MouseEvent): { hue: number; hex: string } | null {
  if (!hueRef.value) return null;
  const { x } = ratioWithin(hueRef.value, event);
  const nextHue = x * 360;
  return { hue: nextHue, hex: hsvToHex({ h: nextHue, s: saturation.value || 1, v: value.value || 1 }) };
}

function onSpectrumMove(event: PointerEvent) {
  previewHex.value = spectrumHexAt(event);
  // Dragging with the button held keeps moving the pending marker; nothing is
  // handed to the parent until the confirm button is pressed.
  if (event.buttons === 1) onSpectrumPick(event);
}

function onSpectrumPick(event: PointerEvent | MouseEvent) {
  if (!spectrumRef.value) return;
  const { x, y } = ratioWithin(spectrumRef.value, event);
  saturation.value = x;
  value.value = 1 - y;
}

function onHueMove(event: PointerEvent) {
  previewHex.value = hueHexAt(event)?.hex ?? null;
  if (event.buttons === 1) onHuePick(event);
}

function onHuePick(event: PointerEvent | MouseEvent) {
  const picked = hueHexAt(event);
  if (!picked) return;
  hue.value = picked.hue;
  if (saturation.value === 0) saturation.value = 1;
  if (value.value === 0) value.value = 1;
}

function clearPreview() {
  previewHex.value = null;
}

/** The only path that hands a value to the parent. */
function confirmPick() {
  emit("update:modelValue", currentHex.value);
  open.value = false;
}

function cancelPick() {
  open.value = false;
}

function onHexInput(raw: string) {
  const trimmed = raw.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) return;
  const hex = trimmed.startsWith("#") ? trimmed.toLowerCase() : `#${trimmed.toLowerCase()}`;
  const hsv = hexToHsv(hex);
  if (!hsv) return;
  if (hsv.s > 0) hue.value = hsv.h;
  saturation.value = hsv.s;
  value.value = hsv.v;
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value || !rootRef.value) return;
  if (!rootRef.value.contains(event.target as Node)) open.value = false;
}

watch(open, (isOpen) => {
  if (typeof document === "undefined") return;
  if (isOpen) {
    syncFromModel();
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
  } else {
    clearPreview();
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  }
});

onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});
</script>

<template>
  <div ref="rootRef" class="relative">
    <button type="button" class="h-6 w-6 shrink-0 rounded border border-border/60 disabled:cursor-not-allowed disabled:opacity-60" :style="{ backgroundColor: props.modelValue }" :disabled="props.disabled" :aria-label="props.label" @click="open = !open" />

    <div v-if="open" class="absolute right-0 top-full z-50 mt-1 w-[224px] rounded-lg border bg-popover p-2 shadow-lg" @pointerleave="clearPreview">
      <!-- Saturation / value gradient for the active hue -->
      <div ref="spectrumRef" class="relative h-[132px] w-full cursor-crosshair rounded" :style="{ backgroundColor: `hsl(${hue}, 100%, 50%)` }" @pointermove="onSpectrumMove" @pointerdown.prevent="onSpectrumPick" @pointerleave="clearPreview">
        <div class="pointer-events-none absolute inset-0 rounded" style="background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0))" />
        <div class="pointer-events-none absolute inset-0 rounded" style="background: linear-gradient(to top, #000, rgba(0, 0, 0, 0))" />
        <div class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" :style="{ left: `${saturation * 100}%`, top: `${(1 - value) * 100}%` }" />
      </div>

      <!-- Hue strip -->
      <div ref="hueRef" class="relative mt-2 h-3 w-full cursor-crosshair rounded" style="background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)" @pointermove="onHueMove" @pointerdown.prevent="onHuePick" @pointerleave="clearPreview">
        <div class="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white shadow" :style="{ left: `${(hue / 360) * 100}%` }" />
      </div>

      <!-- Live readout: follows the cursor, falls back to the pending pick -->
      <div class="mt-2 flex items-center gap-2">
        <div class="h-6 w-6 shrink-0 rounded border border-border/60" :style="{ backgroundColor: readoutHex }" />
        <input type="text" class="w-full min-w-0 rounded border bg-transparent px-1.5 py-0.5 font-mono text-xs" :value="readoutHex" spellcheck="false" @change="onHexInput(($event.target as HTMLInputElement).value)" />
      </div>

      <div class="mt-2 flex items-center justify-end gap-1.5">
        <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="cancelPick">{{ t("settings.cancel") }}</Button>
        <Button size="sm" class="h-7 px-2 text-xs" @click="confirmPick">{{ t("common.confirm") }}</Button>
      </div>
    </div>
  </div>
</template>
