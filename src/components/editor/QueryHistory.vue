<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Search, Trash2, Clock, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useHistoryStore } from "@/stores/historyStore";
import { shouldClearHistory, shouldDeleteHistoryEntry } from "@/lib/historyActions";

const { t } = useI18n();
const store = useHistoryStore();

const emit = defineEmits<{
  restore: [sql: string];
  close: [];
}>();

const searchText = ref("");

const filtered = computed(() => {
  if (!searchText.value) return store.entries;
  const q = searchText.value.toLowerCase();
  return store.entries.filter((e) =>
    e.sql.toLowerCase().includes(q) || e.connection_name.toLowerCase().includes(q) || e.database.toLowerCase().includes(q)
  );
});

function restore(sql: string) {
  emit("restore", sql);
}

function copySql(sql: string) {
  navigator.clipboard.writeText(sql);
}

function confirmDeleteEntry(id: string) {
  if (shouldDeleteHistoryEntry(() => window.confirm(t("history.confirmDelete")))) {
    store.remove(id);
  }
}

function confirmClearHistory() {
  if (shouldClearHistory(store.entries.length, () => window.confirm(t("history.confirmClear")))) {
    store.clear();
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncateSql(sql: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 120) + "..." : line;
}

onMounted(() => store.load());
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden border-l">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <Clock class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span class="text-xs font-medium">{{ t('history.title') }}</span>
      <span class="flex-1" />
      <Button v-if="store.entries.length > 0" variant="ghost" size="icon" class="h-5 w-5" @click="confirmClearHistory">
        <Trash2 class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
        <X class="h-3 w-3" />
      </Button>
    </div>

    <div class="flex items-center gap-1 px-2 py-1 border-b shrink-0">
      <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <input
        v-model="searchText"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="flex-1 h-5 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
        :placeholder="t('history.search')"
      />
    </div>

    <div class="flex-1 overflow-y-auto">
      <ContextMenu v-for="entry in filtered" :key="entry.id">
        <ContextMenuTrigger as-child>
          <div
            class="px-3 py-2 border-b border-border/50 cursor-pointer hover:bg-accent/50 text-xs"
            @click="restore(entry.sql)"
          >
            <div class="flex items-center gap-1 mb-0.5">
              <span class="font-medium truncate">{{ entry.connection_name }}</span>
              <span v-if="entry.database" class="text-muted-foreground">/ {{ entry.database }}</span>
              <span class="ml-auto text-muted-foreground shrink-0">{{ formatTime(entry.executed_at) }}</span>
            </div>
            <div class="font-mono text-muted-foreground truncate">{{ truncateSql(entry.sql) }}</div>
            <div class="flex items-center gap-2 mt-0.5">
              <span :class="entry.success ? 'text-green-500' : 'text-red-500'">
                {{ entry.success ? `${entry.execution_time_ms}ms` : t('history.failed') }}
              </span>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-40">
          <ContextMenuItem @click="restore(entry.sql)">{{ t('history.restore') }}</ContextMenuItem>
          <ContextMenuItem @click="copySql(entry.sql)">{{ t('history.copy') }}</ContextMenuItem>
          <ContextMenuItem class="text-destructive" @click="confirmDeleteEntry(entry.id)">{{ t('history.delete') }}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div v-if="filtered.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
        {{ t('history.empty') }}
      </div>
    </div>
  </div>
</template>
