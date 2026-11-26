<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Bookmark, FolderTree, X } from "@lucide/vue";
import WorkspaceBookmarksPanel from "./WorkspaceBookmarksPanel.vue";

const SqlFilePanel = defineAsyncComponent(() => import("./SqlFilePanel.vue"));
const active = defineModel<"files" | "bookmarks">({ default: "files" });
defineProps<{ locateRequest?: { id: number; path: string } | null }>();
const emit = defineEmits<{ close: []; locateHandled: [id: number] }>();
const { t } = useI18n();
</script>

<template>
  <div class="h-full min-h-0 flex flex-col overflow-hidden rounded-[inherit]">
    <div class="h-9 flex items-center border-b shrink-0 gap-1 px-1 bg-muted/20">
      <div class="flex flex-1 min-w-0" role="tablist" :aria-label="t('editor.bookmarks.workspaceTitle')">
        <button
          id="sql-files-dock-tab"
          type="button"
          role="tab"
          :aria-selected="active === 'files'"
          aria-controls="sql-files-dock-panel"
          class="flex items-center gap-1 px-2 h-8 text-xs rounded-sm"
          :class="active === 'files' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent'"
          @click="active = 'files'"
        >
          <FolderTree class="h-3.5 w-3.5" />{{ t("sqlFileTree.title") }}
        </button>
        <button
          id="bookmarks-dock-tab"
          type="button"
          role="tab"
          :aria-selected="active === 'bookmarks'"
          aria-controls="bookmarks-dock-panel"
          class="flex items-center gap-1 px-2 h-8 text-xs rounded-sm"
          :class="active === 'bookmarks' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent'"
          @click="active = 'bookmarks'"
        >
          <Bookmark class="h-3.5 w-3.5" />{{ t("editor.bookmarks.workspaceTitle") }}
        </button>
      </div>
      <button type="button" class="p-1 rounded hover:bg-accent" :aria-label="t('common.close')" @click="emit('close')"><X class="h-3.5 w-3.5" /></button>
    </div>
    <div v-show="active === 'files'" id="sql-files-dock-panel" role="tabpanel" aria-labelledby="sql-files-dock-tab" class="flex-1 min-h-0">
      <SqlFilePanel :locate-request="locateRequest" @locate-handled="emit('locateHandled', $event)" @close="emit('close')" />
    </div>
    <div v-show="active === 'bookmarks'" id="bookmarks-dock-panel" role="tabpanel" aria-labelledby="bookmarks-dock-tab" class="flex-1 min-h-0"><WorkspaceBookmarksPanel /></div>
  </div>
</template>
