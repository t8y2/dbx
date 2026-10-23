<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, Copy, Database, Search, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useToast } from "@/composables/useToast";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { getFunctionDictionaryForConnection, type FunctionDictionaryEntry, type FunctionDictionaryGroup } from "@/lib/sql/functionDictionary";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{
  connection?: ConnectionConfig;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t, te } = useI18n();
const { toast } = useToast();

const ALL_GROUPS = "__all__";
const SEARCH_RESULT_CAP = 300;

const dictionary = computed(() => getFunctionDictionaryForConnection(props.connection));
const effectiveType = computed(() => effectiveDatabaseTypeForConnection(props.connection));
const searchText = ref("");
const activeGroupId = ref<string>(ALL_GROUPS);
const collapsedGroups = ref<Set<string>>(new Set());
const searchQuery = computed(() => searchText.value.trim().toLowerCase());

watch(
  () => props.connection?.id,
  () => {
    searchText.value = "";
    activeGroupId.value = ALL_GROUPS;
    collapsedGroups.value = new Set();
  },
);

const searchMatches = computed<FunctionDictionaryEntry[] | null>(() => {
  if (!searchQuery.value || !dictionary.value) return null;
  const matches: FunctionDictionaryEntry[] = [];
  for (const group of dictionary.value.groups) {
    for (const entry of group.entries) {
      if (entry.name.toLowerCase().includes(searchQuery.value) || entry.aliases?.some((alias) => alias.toLowerCase().includes(searchQuery.value)) || entry.detail?.toLowerCase().includes(searchQuery.value)) {
        matches.push(entry);
      }
    }
  }
  return matches;
});

const visibleGroups = computed<FunctionDictionaryGroup[]>(() => {
  if (!dictionary.value) return [];
  if (activeGroupId.value === ALL_GROUPS) return dictionary.value.groups;
  return dictionary.value.groups.filter((group) => group.id === activeGroupId.value);
});

/** SQL dictionaries have a single flat group; its header adds nothing, so hide it. */
const showGroupHeaders = computed(() => (dictionary.value?.groups.length ?? 0) > 1);

function isGroupExpanded(groupId: string): boolean {
  return !collapsedGroups.value.has(groupId);
}

function toggleGroup(groupId: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  collapsedGroups.value = next;
}

function groupLabelRaw(group: FunctionDictionaryGroup): string {
  return group.label.charAt(0).toUpperCase() + group.label.slice(1);
}

/** Common SQL functions carry localized descriptions in the completion translations. */
function entryDetail(entry: FunctionDictionaryEntry): string | undefined {
  if (entry.detail) return entry.detail;
  const key = `editor.completion.functionDescriptions.${entry.name}`;
  return te(key) || te(key, "en") ? t(key) : undefined;
}

async function copyName(name: string) {
  try {
    await navigator.clipboard.writeText(name);
    toast(t("functionDictionary.copied"), 1500);
  } catch {
    toast(t("functionDictionary.copyFailed"), 3000);
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden border-l bg-background select-none">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("functionDictionary.title") }}</span>
      <span v-if="dictionary" class="text-[12px] text-muted-foreground ml-1">({{ dictionary.total }})</span>
      <span class="flex-1" />
      <LightTooltip :text="t('common.close')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
          <X class="h-3 w-3" />
        </Button>
      </LightTooltip>
    </div>

    <div v-if="connection" class="flex items-center gap-1.5 px-2 py-1 border-b shrink-0 text-[12px] text-muted-foreground">
      <Database class="h-3 w-3 shrink-0" />
      <span class="truncate">{{ connection.name }}</span>
      <span v-if="effectiveType" class="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{{ effectiveType }}</span>
    </div>

    <div class="border-b shrink-0 px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input v-model="searchText" autocapitalize="off" autocorrect="off" spellcheck="false" class="w-full h-6 pl-7 pr-6 text-[13px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" :placeholder="t('functionDictionary.searchPlaceholder')" />
        <button v-if="searchText" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchText = ''">
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div v-if="dictionary && dictionary.groups.length > 1 && !searchQuery" class="flex flex-wrap gap-1 border-b shrink-0 px-2 py-1.5">
      <button type="button" class="rounded px-1.5 py-0.5 text-[11px] border" :class="activeGroupId === ALL_GROUPS ? 'bg-accent text-accent-foreground border-border' : 'text-muted-foreground border-transparent hover:bg-accent/50'" @click="activeGroupId = ALL_GROUPS">
        {{ t("functionDictionary.allGroups") }} ({{ dictionary.total }})
      </button>
      <button
        v-for="group in dictionary.groups"
        :key="group.id"
        type="button"
        class="rounded px-1.5 py-0.5 text-[11px] border"
        :class="activeGroupId === group.id ? 'bg-accent text-accent-foreground border-border' : 'text-muted-foreground border-transparent hover:bg-accent/50'"
        @click="activeGroupId = group.id"
      >
        {{ groupLabelRaw(group) }} ({{ group.entries.length }})
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!connection" class="px-3 py-8 text-center text-[12px] text-muted-foreground">
        {{ t("functionDictionary.noConnection") }}
      </div>
      <div v-else-if="!dictionary" class="px-3 py-8 text-center text-[12px] text-muted-foreground">
        {{ t("functionDictionary.noData", { type: effectiveType ?? connection.db_type }) }}
      </div>

      <template v-else-if="searchMatches">
        <div class="px-2 py-1 text-[11px] text-muted-foreground">{{ t("functionDictionary.functionsCount", { count: searchMatches.length }) }}</div>
        <div v-for="entry in searchMatches.slice(0, SEARCH_RESULT_CAP)" :key="entry.group + '-' + entry.name" class="group flex cursor-default items-start gap-1 px-2 py-1.5 hover:bg-accent/40">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-1.5">
              <span class="font-mono text-[12px] font-medium truncate">{{ entry.name }}</span>
              <span v-if="entry.overloadCount" class="shrink-0 text-[10px] text-muted-foreground">{{ t("functionDictionary.overloads", { count: entry.overloadCount }) }}</span>
              <span v-if="entry.argsHint" class="shrink-0 text-[10px] text-muted-foreground">{{ t("functionDictionary.argsCount", { count: entry.argsHint }) }}</span>
            </div>
            <div v-if="entry.signature" class="font-mono text-[11px] text-muted-foreground truncate" :title="entry.signature">{{ entry.signature }}</div>
            <div v-if="entry.aliases?.length" class="text-[11px] text-muted-foreground/80 truncate">{{ t("functionDictionary.aliases", { aliases: entry.aliases.join(", ") }) }}</div>
            <div v-if="entryDetail(entry)" class="text-[11px] text-muted-foreground/80 truncate" :title="entryDetail(entry)">{{ entryDetail(entry) }}</div>
          </div>
          <LightTooltip :text="t('functionDictionary.copy')" side="left" :delay="0" :close-delay="0" nowrap>
            <button
              type="button"
              class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              :aria-label="t('functionDictionary.copy')"
              @click="copyName(entry.name)"
            >
              <Copy class="h-3 w-3" />
            </button>
          </LightTooltip>
        </div>
        <div v-if="searchMatches.length > SEARCH_RESULT_CAP" class="px-2 py-2 text-[11px] text-muted-foreground">
          {{ t("functionDictionary.moreResults", { count: searchMatches.length - SEARCH_RESULT_CAP }) }}
        </div>
      </template>

      <template v-else>
        <div v-for="group in visibleGroups" :key="group.id">
          <button v-if="showGroupHeaders" type="button" class="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground sticky top-0 bg-background/95 backdrop-blur-sm border-b" @click="toggleGroup(group.id)">
            <component :is="isGroupExpanded(group.id) ? ChevronDown : ChevronRight" class="h-3 w-3 shrink-0" />
            <span class="truncate">{{ groupLabelRaw(group) }}</span>
            <span class="ml-auto shrink-0">({{ group.entries.length }})</span>
          </button>
          <div v-show="!showGroupHeaders || isGroupExpanded(group.id)">
            <div v-for="entry in group.entries" :key="entry.name" class="group flex cursor-default items-start gap-1 px-2 py-1.5 hover:bg-accent/40">
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-1.5">
                  <span class="font-mono text-[12px] font-medium truncate">{{ entry.name }}</span>
                  <span v-if="entry.overloadCount" class="shrink-0 text-[10px] text-muted-foreground">{{ t("functionDictionary.overloads", { count: entry.overloadCount }) }}</span>
                  <span v-if="entry.argsHint" class="shrink-0 text-[10px] text-muted-foreground">{{ t("functionDictionary.argsCount", { count: entry.argsHint }) }}</span>
                </div>
                <div v-if="entry.signature" class="font-mono text-[11px] text-muted-foreground truncate" :title="entry.signature">{{ entry.signature }}</div>
                <div v-if="entry.aliases?.length" class="text-[11px] text-muted-foreground/80 truncate">{{ t("functionDictionary.aliases", { aliases: entry.aliases.join(", ") }) }}</div>
                <div v-if="entryDetail(entry)" class="text-[11px] text-muted-foreground/80 truncate" :title="entryDetail(entry)">{{ entryDetail(entry) }}</div>
              </div>
              <LightTooltip :text="t('functionDictionary.copy')" side="left" :delay="0" :close-delay="0" nowrap>
                <button
                  type="button"
                  class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  :aria-label="t('functionDictionary.copy')"
                  @click="copyName(entry.name)"
                >
                  <Copy class="h-3 w-3" />
                </button>
              </LightTooltip>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
