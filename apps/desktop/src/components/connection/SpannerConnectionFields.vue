<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseSpannerResourcePath, spannerResourceParts, withSpannerResourcePart, type SpannerResourceParts } from "@/lib/connection/spannerResourcePath";

const database = defineModel<string | undefined>("database");
const emit = defineEmits<{ change: [] }>();
const { t } = useI18n();

// The editing mode is derived, never persisted: a value that already parses as a
// resource path opens in the structured editor, anything else (hand-written or
// non-standard paths) opens in the raw editor so nothing is silently dropped.
const rawMode = ref(!!database.value?.trim() && !parseSpannerResourcePath(database.value));

function resourcePart(key: keyof SpannerResourceParts) {
  return computed({
    get: () => spannerResourceParts(database.value)[key],
    set: (value: string) => {
      database.value = withSpannerResourcePart(database.value, key, value) || undefined;
      emit("change");
    },
  });
}

const project = resourcePart("project");
const instance = resourcePart("instance");
const databaseId = resourcePart("database");

const resourcePath = computed({
  get: () => database.value ?? "",
  set: (value: string) => {
    database.value = value || undefined;
    emit("change");
  },
});

function setRawMode(value: boolean) {
  rawMode.value = value;
}
</script>

<template>
  <div data-spanner-resource-fields class="contents">
    <div class="grid grid-cols-4 items-center gap-4">
      <Label class="justify-self-start text-left text-xs">{{ t("connection.mode") }}</Label>
      <div class="col-span-3 grid h-8 grid-cols-2 overflow-hidden rounded-md border border-input bg-muted/30 p-0.5">
        <button type="button" class="h-7 rounded-sm px-3 text-sm transition-colors" :class="rawMode ? 'text-muted-foreground hover:text-foreground' : 'bg-background text-foreground shadow-sm'" :aria-pressed="!rawMode" @click="setRawMode(false)">
          {{ t("connection.spannerStructuredMode") }}
        </button>
        <button type="button" class="h-7 rounded-sm px-3 text-sm transition-colors" :class="rawMode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" :aria-pressed="rawMode" @click="setRawMode(true)">
          {{ t("connection.spannerResourcePathMode") }}
        </button>
      </div>
    </div>

    <template v-if="!rawMode">
      <div class="grid grid-cols-4 items-center gap-4">
        <Label class="justify-self-start text-left">{{ t("connection.spannerProject") }}</Label>
        <Input v-model="project" class="col-span-3" placeholder="my-project" />
      </div>

      <div class="grid grid-cols-4 items-center gap-4">
        <Label class="justify-self-start text-left">{{ t("connection.spannerInstance") }}</Label>
        <Input v-model="instance" class="col-span-3" placeholder="my-instance" />
      </div>

      <div class="grid grid-cols-4 items-center gap-4">
        <Label class="justify-self-start text-left">{{ t("connection.spannerDatabase") }}</Label>
        <Input v-model="databaseId" class="col-span-3" placeholder="my-database" />
      </div>
    </template>

    <div v-else class="grid grid-cols-4 items-center gap-4">
      <Label class="justify-self-start text-left">{{ t("connection.spannerResourcePathMode") }}</Label>
      <Input v-model="resourcePath" class="col-span-3" :placeholder="t('connection.spannerResourcePathHint')" />
    </div>

    <div class="grid grid-cols-4 items-start gap-4">
      <span />
      <p class="col-span-3 text-xs leading-5 text-muted-foreground">{{ t("connection.spannerCredentialsHint") }}</p>
    </div>
  </div>
</template>
