<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Search } from "@lucide/vue";
import type { TopicInfo } from "@/types/mq";
import { mqListTopics } from "@/lib/backend/api";
import { isRocketMqBusinessMessageType, resolveRocketMqMessageType } from "@/lib/mq/rocketmqTopicTypes";

type TopicGrouping = "business" | "dlq" | "all";
type TopicTypeFilter = "all" | "business" | "dlq";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  modelValue: string;
  grouping?: TopicGrouping;
  disabled?: boolean;
  placeholder?: string;
  showTypeFilter?: boolean;
  showHint?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  grouping: "all",
  disabled: false,
  placeholder: undefined,
  showTypeFilter: true,
  showHint: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  loaded: [topics: TopicInfo[]];
  /** Fired when the user picks a topic from the dropdown list. */
  select: [value: string];
}>();

const { t } = useI18n();

const topics = ref<TopicInfo[]>([]);
const loading = ref(false);
const typeFilter = ref<TopicTypeFilter>("all");
const searchText = ref("");
const dropdownOpen = ref(false);
const highlightIndex = ref(-1);
const rootRef = ref<HTMLElement>();
const inputRef = ref<HTMLInputElement>();

const listboxId = computed(() => `mq-topic-listbox-${props.connectionId}-${props.tenant ?? ""}-${props.namespace ?? ""}`);

const effectiveTypeFilter = computed<TopicTypeFilter>(() => {
  if (props.grouping === "business") return "business";
  if (props.grouping === "dlq") return "dlq";
  return typeFilter.value;
});

const filteredTopics = computed(() => {
  if (effectiveTypeFilter.value === "business") {
    return topics.value.filter((topic) => isRocketMqBusinessMessageType(resolveRocketMqMessageType(topic)));
  }
  if (effectiveTypeFilter.value === "dlq") {
    return topics.value.filter((topic) => resolveRocketMqMessageType(topic) === "DLQ");
  }
  return topics.value;
});

const topicOptions = computed(() => filteredTopics.value.map((topic) => topic.shortName));

const visibleOptions = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();
  if (!keyword) return topicOptions.value;
  return topicOptions.value.filter((option) => option.toLowerCase().includes(keyword));
});

const inputPlaceholder = computed(() => props.placeholder ?? (loading.value ? t("mqMessages.topicLoading") : t("mqMessages.selectTopicPlaceholder")));

const showCommittedOverlay = computed(() => dropdownOpen.value && !!props.modelValue);

const activeOptionId = computed(() => (highlightIndex.value >= 0 ? `${listboxId.value}-option-${highlightIndex.value}` : undefined));

function topicTypeLabel(topicName: string): string | undefined {
  const topic = topics.value.find((item) => item.shortName === topicName);
  if (!topic) return undefined;
  const type = resolveRocketMqMessageType(topic);
  return t(`mqTopics.rocketmqType.${type.toLowerCase()}`);
}

function isKnownTopic(topicName: string): boolean {
  const name = topicName.trim();
  if (!name) return false;
  return topicOptions.value.includes(name);
}

function syncHighlightToSelection() {
  const selectedIndex = visibleOptions.value.findIndex((option) => option === props.modelValue);
  highlightIndex.value = selectedIndex >= 0 ? selectedIndex : visibleOptions.value.length ? 0 : -1;
}

async function focusSearchInput() {
  await nextTick();
  const input = inputRef.value;
  if (!input) return;
  input.focus();
  input.setSelectionRange(0, 0);
}

function openDropdown() {
  if (props.disabled || loading.value) return;
  searchText.value = "";
  dropdownOpen.value = true;
  syncHighlightToSelection();
  void focusSearchInput();
}

function closeDropdown() {
  dropdownOpen.value = false;
  highlightIndex.value = -1;
  searchText.value = "";
}

function selectOption(option: string) {
  emit("update:modelValue", option);
  emit("select", option);
  closeDropdown();
}

function handleInput(event: Event) {
  searchText.value = (event.target as HTMLInputElement).value;
  if (!dropdownOpen.value) dropdownOpen.value = true;
  highlightIndex.value = visibleOptions.value.length ? 0 : -1;
}

function handleWrapMouseDown(event: MouseEvent) {
  if (props.disabled || loading.value) return;
  if ((event.target as HTMLElement).closest(".mq-btn-icon")) return;
  if (!dropdownOpen.value) {
    event.preventDefault();
    openDropdown();
  }
}

function handleBlur() {
  window.setTimeout(() => {
    if (rootRef.value?.contains(document.activeElement)) return;
    closeDropdown();
  }, 0);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!dropdownOpen.value) openDropdown();
    if (!visibleOptions.value.length) return;
    highlightIndex.value = highlightIndex.value < visibleOptions.value.length - 1 ? highlightIndex.value + 1 : 0;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!dropdownOpen.value) openDropdown();
    if (!visibleOptions.value.length) return;
    highlightIndex.value = highlightIndex.value > 0 ? highlightIndex.value - 1 : visibleOptions.value.length - 1;
  } else if (event.key === "Enter") {
    if (!dropdownOpen.value || highlightIndex.value < 0 || highlightIndex.value >= visibleOptions.value.length) return;
    event.preventDefault();
    selectOption(visibleOptions.value[highlightIndex.value]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeDropdown();
    inputRef.value?.blur();
  } else if (event.key === "Backspace" && showCommittedOverlay.value && !searchText.value) {
    event.preventDefault();
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!dropdownOpen.value) return;
  const root = rootRef.value;
  if (root && !root.contains(event.target as Node)) {
    closeDropdown();
  }
}

async function loadTopics() {
  if (!props.tenant || !props.namespace) {
    topics.value = [];
    emit("loaded", []);
    return;
  }
  loading.value = true;
  try {
    topics.value = await mqListTopics(
      props.connectionId,
      {
        tenant: props.tenant,
        namespace: props.namespace,
      },
      { includeNonPersistent: false },
    );
    emit("loaded", topics.value);
  } catch (e: unknown) {
    console.warn("[DBX] Failed to load RocketMQ topics:", e);
    topics.value = [];
    emit("loaded", []);
  } finally {
    loading.value = false;
  }
}

function setTypeFilter(filter: TopicTypeFilter) {
  if (props.grouping !== "all") return;
  typeFilter.value = filter;
}

watch(filteredTopics, (nextTopics) => {
  if (!props.modelValue) return;
  if (!nextTopics.some((topic) => topic.shortName === props.modelValue)) {
    emit("update:modelValue", "");
  }
});

watch(dropdownOpen, (open) => {
  if (open) {
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    return;
  }
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

watch(
  () => [props.tenant, props.namespace, props.connectionId],
  () => {
    void loadTopics();
  },
  { immediate: true },
);

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

defineExpose({
  loadTopics,
  topics,
  loading,
  isKnownTopic,
  topicTypeLabel,
  resolveTopicType: (topicName: string) => {
    const topic = topics.value.find((item) => item.shortName === topicName.trim());
    return topic ? resolveRocketMqMessageType(topic) : undefined;
  },
});
</script>

<template>
  <div class="rocketmq-topic-select">
    <div v-if="showTypeFilter && grouping === 'all'" class="mq-topic-type-chips">
      <button type="button" class="mq-topic-type-chip" :class="{ active: typeFilter === 'all' }" @click="setTypeFilter('all')">
        {{ t("mqRocketmq.topicFilterAll") }}
      </button>
      <button type="button" class="mq-topic-type-chip" :class="{ active: typeFilter === 'business' }" @click="setTypeFilter('business')">
        {{ t("mqRocketmq.topicFilterBusiness") }}
      </button>
      <button type="button" class="mq-topic-type-chip" :class="{ active: typeFilter === 'dlq' }" @click="setTypeFilter('dlq')">
        {{ t("mqRocketmq.topicFilterDlq") }}
      </button>
    </div>
    <div class="mq-topic-select-row">
      <div ref="rootRef" class="topic-combobox">
        <div class="topic-combobox-input-wrap" :class="{ open: dropdownOpen, disabled: disabled || loading }" @mousedown="handleWrapMouseDown">
          <template v-if="dropdownOpen">
            <div class="topic-combobox-field">
              <span v-if="showCommittedOverlay && !searchText" class="committed-overlay" aria-hidden="true">{{ modelValue }}</span>
              <input
                ref="inputRef"
                class="topic-combobox-input"
                :value="searchText"
                :placeholder="showCommittedOverlay ? '' : inputPlaceholder"
                :disabled="disabled || loading"
                role="combobox"
                aria-autocomplete="list"
                :aria-expanded="dropdownOpen"
                :aria-controls="listboxId"
                :aria-activedescendant="activeOptionId"
                autocomplete="off"
                @blur="handleBlur"
                @input="handleInput"
                @keydown="handleKeydown"
              />
            </div>
          </template>
          <button v-else type="button" class="topic-combobox-trigger" :disabled="disabled || loading" :title="modelValue || inputPlaceholder">
            <span v-if="modelValue" class="committed-value">{{ modelValue }}</span>
            <span v-else class="committed-placeholder">{{ inputPlaceholder }}</span>
          </button>
          <Search class="topic-combobox-search-icon" aria-hidden="true" />
        </div>
        <div v-if="dropdownOpen" :id="listboxId" class="topic-combobox-dropdown" role="listbox">
          <div v-if="loading" class="topic-combobox-empty">{{ t("mqMessages.topicLoading") }}</div>
          <template v-else-if="visibleOptions.length">
            <button
              v-for="(option, index) in visibleOptions"
              :id="`${listboxId}-option-${index}`"
              :key="option"
              type="button"
              role="option"
              :aria-selected="option === modelValue"
              class="topic-combobox-option"
              :class="{ active: index === highlightIndex }"
              @mousedown.prevent="selectOption(option)"
              @mouseenter="highlightIndex = index"
            >
              {{ option }}
            </button>
          </template>
          <div v-else class="topic-combobox-empty">{{ t("mqTopics.noMatches") }}</div>
        </div>
      </div>
      <button type="button" class="mq-btn-icon" :disabled="loading || disabled || !tenant || !namespace" :title="t('mqMessages.refreshTopicList')" @click="loadTopics">
        <span :class="{ 'mq-spin': loading }">⟳</span>
      </button>
    </div>
    <template v-if="showHint">
      <div v-if="!filteredTopics.length && !loading" class="topic-hint">{{ t("mqMessages.noTopicsAvailable") }}</div>
      <div v-else class="topic-hint">{{ t("mqMessages.topicSearchHint") }}</div>
    </template>
  </div>
</template>

<style scoped>
@import "./mqPanel.css";

.rocketmq-topic-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.mq-topic-select-row {
  width: 100%;
  min-width: 0;
}

.topic-combobox {
  position: relative;
  flex: 1;
  min-width: 0;
}

.topic-combobox-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 34px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.topic-combobox-input-wrap.open,
.topic-combobox-input-wrap:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.topic-combobox-input-wrap.disabled {
  opacity: 0.6;
}

.topic-combobox-field {
  position: relative;
  flex: 1;
  min-width: 0;
}

.committed-overlay {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  max-width: calc(100% - 44px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-tertiary);
  font-size: 13px;
  line-height: 1;
  user-select: none;
  pointer-events: none;
}

.topic-combobox-trigger {
  flex: 1;
  min-width: 0;
  padding: 7px 34px 7px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.committed-value {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: 13px;
}

.committed-placeholder {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.topic-combobox-input {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 7px 34px 7px 10px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  outline: none;
}

.topic-combobox-search-icon {
  position: absolute;
  right: 10px;
  width: 14px;
  height: 14px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

.topic-combobox-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.topic-combobox-option {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.topic-combobox-option:hover,
.topic-combobox-option.active {
  background: var(--color-background-secondary);
}

.topic-combobox-empty {
  padding: 10px 12px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.topic-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>
