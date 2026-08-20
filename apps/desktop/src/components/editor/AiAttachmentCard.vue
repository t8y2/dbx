<script setup lang="ts">
import { AlertTriangle, FileText, Image, X } from "@lucide/vue";

withDefaults(
  defineProps<{
    kind: "image" | "text";
    name: string;
    detail?: string;
    previewUrl?: string;
    status?: "ready" | "truncated" | "unsupported" | "unavailable";
    removable?: boolean;
    removeLabel?: string;
    previewLabel?: string;
    encoding?: string;
    encodingLabel?: string;
    encodingOptions?: ReadonlyArray<{ value: string; label: string }>;
  }>(),
  {
    detail: "",
    previewUrl: "",
    status: "ready",
    removable: false,
    removeLabel: "Remove",
    previewLabel: "Preview",
    encoding: "",
    encodingLabel: "Encoding",
    encodingOptions: () => [],
  },
);

const emit = defineEmits<{
  remove: [];
  preview: [];
  encodingChange: [value: string];
}>();

function onEncodingChange(event: Event) {
  emit("encodingChange", (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="group flex h-12 min-w-0 max-w-full items-center gap-2 rounded-md border bg-muted/45 p-1.5 text-left shadow-sm" :class="status === 'unsupported' || status === 'unavailable' ? 'border-amber-500/45 bg-amber-500/5' : 'border-border/80'">
    <button v-if="kind === 'image' && previewUrl" type="button" class="relative h-9 w-9 shrink-0 overflow-hidden rounded border border-border/70 bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="`${previewLabel}: ${name}`" @click="emit('preview')">
      <img :src="previewUrl" :alt="name" class="h-full w-full object-cover" />
    </button>
    <div v-else class="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-border/70 bg-background text-muted-foreground">
      <AlertTriangle v-if="status === 'unsupported' || status === 'unavailable'" class="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <Image v-else-if="kind === 'image'" class="h-4 w-4" />
      <FileText v-else class="h-4 w-4" />
    </div>

    <div class="min-w-0 flex-1">
      <div class="truncate text-[11px] font-medium text-foreground" :title="name">{{ name }}</div>
      <div class="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
        <span v-if="detail" class="min-w-0 flex-1 truncate" :title="detail">{{ detail }}</span>
        <select
          v-if="encodingOptions.length"
          :value="encoding"
          class="h-4 max-w-24 shrink-0 rounded border border-border/70 bg-background px-0.5 text-[9px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :aria-label="`${encodingLabel}: ${name}`"
          :title="encodingLabel"
          @change="onEncodingChange"
        >
          <option v-for="option in encodingOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
    </div>

    <button
      v-if="removable"
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      :aria-label="`${removeLabel}: ${name}`"
      :title="`${removeLabel}: ${name}`"
      @click="emit('remove')"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
