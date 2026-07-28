<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown, ChevronUp, Search, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  suggestions: string[];
  suggestionIndex: number;
  matchCount: number;
  currentMatchIndex: number;
  hasDeferredSearchText: boolean;
}>();

const searchText = defineModel<string>("text", { default: "" });
const emit = defineEmits<{
  keydown: [event: KeyboardEvent];
  close: [];
  navigate: [delta: number];
  acceptSuggestion: [index: number];
  hoverSuggestion: [index: number];
}>();

const searchInput = ref<HTMLInputElement>();

function onSuggestionMouseDown(event: MouseEvent, index: number) {
  event.preventDefault();
  emit("acceptSuggestion", index);
}

function keepSearchInputFocused(event: MouseEvent) {
  // Pointer navigation should not move focus away from the search input; keyboard activation still uses click.
  event.preventDefault();
}

defineExpose({
  focus: (select = false) => {
    searchInput.value?.focus();
    if (select) searchInput.value?.select();
  },
});
</script>

<template>
  <Transition enter-active-class="transition-opacity duration-150" leave-active-class="transition-opacity duration-100" enter-from-class="opacity-0" leave-to-class="opacity-0">
    <div v-if="props.open" class="absolute top-1 right-2 z-20 flex items-center gap-1 px-2 py-1 bg-background border rounded-md shadow-md">
      <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <input
        ref="searchInput"
        v-model="searchText"
        type="search"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        class="w-48 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
        :placeholder="t('grid.search')"
        @keydown="emit('keydown', $event)"
      />
      <div v-if="props.suggestions.length > 0" class="absolute top-full right-0 mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md">
        <div
          v-for="(suggestion, index) in props.suggestions"
          :key="suggestion"
          class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
          :class="index === props.suggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
          @mousedown="onSuggestionMouseDown($event, index)"
          @mouseenter="emit('hoverSuggestion', index)"
        >
          <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
          <span>{{ suggestion }}</span>
        </div>
      </div>
      <span v-if="props.matchCount > 0" class="text-xs text-muted-foreground shrink-0">{{ props.currentMatchIndex + 1 }}/{{ props.matchCount }}</span>
      <span v-else-if="props.hasDeferredSearchText" class="text-xs text-muted-foreground shrink-0">0</span>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0"
        :disabled="props.matchCount === 0"
        :title="t('search.prevMatch')"
        :aria-label="t('search.prevMatch')"
        @mousedown="keepSearchInputFocused"
        @click="emit('navigate', -1)"
      >
        <ChevronUp class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0"
        :disabled="props.matchCount === 0"
        :title="t('search.nextMatch')"
        :aria-label="t('search.nextMatch')"
        @mousedown="keepSearchInputFocused"
        @click="emit('navigate', 1)"
      >
        <ChevronDown class="w-3.5 h-3.5" />
      </button>
      <button type="button" class="text-muted-foreground hover:text-foreground shrink-0" :title="t('search.close')" :aria-label="t('search.close')" @click="emit('close')">
        <X class="w-3.5 h-3.5" />
      </button>
    </div>
  </Transition>
</template>
