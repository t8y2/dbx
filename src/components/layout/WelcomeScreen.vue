<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { FilePlus2, Plus, History, Upload, Database, Search, ShieldCheck, Sparkles } from "lucide-vue-next";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { connectionDriverLabel, connectionIconType, connectionOptionSubtitle } from "@/lib/connectionPresentation";
import type { ConnectionConfig } from "@/types/database";

defineProps<{
  connectionStats: { total: number; connected: number; types: number }
  recentConnections: ConnectionConfig[]
  appVersion: string
  hasConnections: boolean
}>();

const emit = defineEmits<{
  'open-connection-query': [connectionId: string]
  'new-connection': []
  'new-query': []
  'show-history': []
  'import-config': []
  'open-github': []
  'open-mcp-guide': []
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex-1 overflow-auto bg-background">
    <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center gap-6 px-8 py-10">
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Database class="h-3.5 w-3.5" /> {{ t('welcome.connections') }}
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.total }}</div>
        </div>
        <div class="rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck class="h-3.5 w-3.5" /> {{ t('welcome.connected') }}
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.connected }}</div>
        </div>
        <div class="rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles class="h-3.5 w-3.5" /> {{ t('welcome.databaseTypes') }}
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.types }}</div>
        </div>
      </div>

      <div class="grid grid-cols-[1.2fr_0.8fr] gap-4">
        <div class="rounded-lg border">
          <div class="flex items-center justify-between border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t('welcome.quickConnections') }}</div>
          </div>
          <div class="divide-y">
            <button
              v-for="connection in recentConnections"
              :key="connection.id"
              class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
              @click="emit('open-connection-query', connection.id)"
            >
              <DatabaseIcon :db-type="connectionIconType(connection)" class="h-4 w-4" />
              <span class="h-5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color || '#9ca3af' }" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ connection.name }}</div>
                <div class="truncate text-xs text-muted-foreground">
                  {{ connectionOptionSubtitle(connection) || connectionDriverLabel(connection) }}
                </div>
              </div>
              <FilePlus2 class="h-4 w-4 text-muted-foreground" />
            </button>
            <div v-if="recentConnections.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
              {{ t('sidebar.noConnections') }}
            </div>
          </div>
        </div>

        <div class="rounded-lg border">
          <div class="border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t('welcome.shortcuts') }}</div>
          </div>
          <div class="grid gap-1 p-2">
            <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('new-connection')">
              <Plus class="h-4 w-4" /> {{ t('toolbar.newConnection') }}
            </button>
            <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" :disabled="!hasConnections" @click="emit('new-query')">
              <FilePlus2 class="h-4 w-4" /> {{ t('toolbar.newQuery') }}
            </button>
            <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('show-history')">
              <History class="h-4 w-4" /> {{ t('history.title') }}
            </button>
            <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('import-config')">
              <Upload class="h-4 w-4" /> {{ t('sidebar.import') }}
            </button>
            <div class="mt-2 rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              <Search class="mr-1 inline h-3.5 w-3.5" />
              {{ t('welcome.tip') }}
            </div>
          </div>
        </div>
      </div>

      <!-- MCP Integration Hint -->
      <div class="rounded-lg border bg-muted/10 px-5 py-4">
        <div class="flex items-start gap-3">
          <Sparkles class="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ t('welcome.mcpTitle') }}</div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t('welcome.mcpDescription') }}</p>
            <div class="mt-2 flex items-center gap-2">
              <code class="rounded bg-muted px-2 py-0.5 text-[11px] select-all">npx @dbx-app/mcp-server</code>
              <a href="#" class="text-xs text-primary hover:underline" @click.prevent="emit('open-mcp-guide')">{{ t('welcome.mcpLearnMore') }}</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Project Info -->
      <div class="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/60">
        <span>DBX {{ appVersion ? 'v' + appVersion : '' }}</span>
        <span>·</span>
        <a href="#" class="hover:text-foreground transition-colors" @click.prevent="emit('open-github')">GitHub</a>
      </div>
    </div>
  </div>
</template>
