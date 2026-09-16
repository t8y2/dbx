<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import DocsApp from "@/docs/DocsApp.vue";
import { formatDocsHash, parseDocsHash } from "@/docs/docsRoute";
import type { DocsRoute } from "@/docs/docsRoute";
import { LOCALE_OPTIONS } from "@/lib/app/localeOptions";
import type { ExportPayload } from "./exportPayload";
import { createExportTranslate, EXPORT_LOCALES } from "./exportTranslate";
import type { ExportLocale } from "./exportTranslate";

const props = defineProps<{ payload: ExportPayload }>();

/**
 * The reader is not the exporter, so both controls below are theirs to change
 * and neither is persisted: under `file://` every document shares one opaque
 * origin, so `localStorage` would leak one export's preference into an
 * unrelated one.
 */
const lang = ref<ExportLocale>(props.payload.lang in EXPORT_LOCALES ? props.payload.lang : "en");
const translate = computed(() => createExportTranslate(lang.value));

// Derived from the app's own list so the endonyms cannot drift, filtered to
// what this bundle can actually render.
const languages = LOCALE_OPTIONS.filter((option) => option.value in EXPORT_LOCALES);

/**
 * Nothing applies `.dark` in a standalone file: DBX's theme system is not
 * here. `prefers-color-scheme` is the only signal the document has on load,
 * and the select overrides it from then on.
 */
const theme = ref<"light" | "dark">(typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

watch(
  theme,
  (value) => {
    // The same two writes the app makes (composables/useTheme.ts): the class
    // drives the tokens and the `dark:` variant, `color-scheme` drives the
    // form controls and scrollbars the page does not style itself.
    const root = document.documentElement;
    root.classList.toggle("dark", value === "dark");
    root.style.colorScheme = value;
  },
  { immediate: true },
);

// export.rs sets `<html lang>` correctly at export time, but that is a
// snapshot of the moment the file was generated — nothing here kept it in
// sync with the reader's own choice. Without this, switching languages left
// screen readers and hyphenation reading the export-time locale forever.
watch(
  lang,
  (value) => {
    document.documentElement.lang = value;
  },
  { immediate: true },
);

const route = ref<DocsRoute>(parseDocsHash(location.hash, props.payload.snapshot, true));

// The URL is the source of truth, so Back and Forward work and a link to a
// table survives being copied out of the address bar.
function readHash(): void {
  route.value = parseDocsHash(location.hash, props.payload.snapshot, true);
}

function navigate(next: DocsRoute): void {
  route.value = next;
  const hash = formatDocsHash(next);
  if (location.hash !== hash) location.hash = hash;
}

onMounted(() => window.addEventListener("hashchange", readHash));
onBeforeUnmount(() => window.removeEventListener("hashchange", readHash));
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <div class="flex shrink-0 flex-wrap items-center justify-end gap-4 border-b border-border px-4 py-2">
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        {{ translate("docs.theme") }}
        <select v-model="theme" class="rounded border border-border bg-background px-2 py-1 text-xs text-foreground">
          <option value="light">{{ translate("docs.themeLight") }}</option>
          <option value="dark">{{ translate("docs.themeDark") }}</option>
        </select>
      </label>

      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        {{ translate("docs.language") }}
        <select v-model="lang" class="rounded border border-border bg-background px-2 py-1 text-xs text-foreground">
          <option v-for="option in languages" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
    </div>

    <DocsApp class="min-h-0 flex-1" :snapshot="payload.snapshot" :annotations="payload.annotations" :readonly="true" :translate="translate" :route="route" diagram="inline" @update:route="navigate" />
  </div>
</template>
