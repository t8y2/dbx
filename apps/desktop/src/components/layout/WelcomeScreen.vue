<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ArrowRight, Code2, Database, DatabaseZap, Download, FilePlus2, History, Plus, Search, Settings2, ShieldCheck, Sparkles, Table2 } from "@lucide/vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import { connectionDriverLabel, connectionIconType, connectionRedactedNameLabel, connectionRedactedOptionSubtitle } from "@/lib/connection/connectionPresentation";
import type { WelcomePageMode } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

export interface WelcomeSavedSqlHistoryItem {
  id: string;
  name: string;
  connectionName: string;
  database?: string;
  folderName?: string;
  openCount?: number;
}

defineProps<{
  connectionStats: { total: number; connected: number; types: number };
  recentConnections: ConnectionConfig[];
  savedSqlHistoryItems: WelcomeSavedSqlHistoryItem[];
  welcomePageMode: WelcomePageMode;
  appVersion: string;
  canNewQuery: boolean;
}>();

const emit = defineEmits<{
  "open-connection-query": [connectionId: string];
  "open-saved-sql": [fileId: string];
  "new-connection": [];
  "new-query": [];
  "show-history": [];
  "import-config": [];
  "open-github": [];
  "open-mcp-guide": [];
  "open-website": [];
  "open-settings": [];
}>();

const { t } = useI18n();

function welcomeConnectionSubtitle(connection: ConnectionConfig): string {
  return connectionRedactedOptionSubtitle(connection) || connectionDriverLabel(connection);
}
</script>

<template>
  <div class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background">
    <div v-if="welcomePageMode !== 'workspace'" class="welcome-intro mx-auto flex min-h-full w-full min-w-0 max-w-5xl flex-col justify-center px-6 py-10 sm:px-8">
      <div class="welcome-intro-hero relative overflow-hidden rounded-2xl border px-6 py-10 sm:px-10 sm:py-14">
        <div class="welcome-intro-glow pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
        <div class="relative max-w-2xl">
          <div class="flex items-center gap-3">
            <div class="flex h-11 w-11 items-center justify-center rounded-xl border bg-background/80 p-2 shadow-sm"><AppLogo class="h-full w-full object-contain" /></div>
            <div class="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">{{ t("welcome.introEyebrow") }}</div>
          </div>
          <h1 class="mt-7 text-3xl font-semibold tracking-tight sm:text-4xl">{{ t("welcome.introTitle") }}</h1>
          <p class="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{{ t("welcome.introDescription") }}</p>
          <div class="mt-7 flex flex-wrap items-center gap-2">
            <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90" @click="emit('new-connection')">
              <Plus class="h-4 w-4" /> {{ t("welcome.introNewConnection") }} <ArrowRight class="h-3.5 w-3.5" />
            </button>
            <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md border bg-background/70 px-4 text-sm font-medium transition-colors hover:bg-muted" @click="emit('import-config')"><Download class="h-4 w-4" /> {{ t("welcome.introImport") }}</button>
          </div>
        </div>
      </div>

      <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-xl border bg-muted/20 p-4">
          <DatabaseZap class="h-5 w-5 text-primary" />
          <div class="mt-3 text-sm font-medium">{{ t("welcome.introFeatureConnections") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("welcome.introFeatureConnectionsDescription") }}</p>
        </div>
        <div class="rounded-xl border bg-muted/20 p-4">
          <Code2 class="h-5 w-5 text-primary" />
          <div class="mt-3 text-sm font-medium">{{ t("welcome.introFeatureSql") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("welcome.introFeatureSqlDescription") }}</p>
        </div>
        <div class="rounded-xl border bg-muted/20 p-4">
          <Table2 class="h-5 w-5 text-primary" />
          <div class="mt-3 text-sm font-medium">{{ t("welcome.introFeatureData") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("welcome.introFeatureDataDescription") }}</p>
        </div>
        <div class="rounded-xl border bg-muted/20 p-4">
          <Sparkles class="h-5 w-5 text-primary" />
          <div class="mt-3 text-sm font-medium">{{ t("welcome.introFeatureAi") }}</div>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("welcome.introFeatureAiDescription") }}</p>
        </div>
      </div>

      <div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/10 px-4 py-3 text-xs text-muted-foreground">
        <div class="flex items-center gap-2"><ShieldCheck class="h-4 w-4 text-primary" /> {{ t("welcome.introPrivacyHint") }}</div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="inline-flex items-center gap-1.5 hover:text-foreground" @click="emit('show-history')"><History class="h-3.5 w-3.5" /> {{ t("history.title") }}</button>
          <button type="button" class="inline-flex items-center gap-1.5 hover:text-foreground" @click="emit('open-settings')"><Settings2 class="h-3.5 w-3.5" /> {{ t("welcome.introSettings") }}</button>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/60">
        <span>DBX {{ appVersion ? "v" + appVersion : "" }}</span
        ><span>·</span>
        <a href="#" class="hover:text-foreground" @click.prevent="emit('open-github')">GitHub</a>
        <span>·</span><button type="button" class="hover:text-foreground" @click="emit('open-website')">{{ t("welcome.mcpLearnMore") }}</button>
      </div>
    </div>

    <div v-else class="welcome-content mx-auto flex min-h-full w-full min-w-0 max-w-5xl flex-col justify-center gap-6 px-8 py-10">
      <div class="welcome-stats-grid grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Database class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.connections") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.total }}</div>
        </div>
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.connected") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.connected }}</div>
        </div>
        <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/20 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Sparkles class="h-3.5 w-3.5 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.databaseTypes") }}</span>
          </div>
          <div class="mt-2 text-2xl font-semibold">{{ connectionStats.types }}</div>
        </div>
      </div>

      <div class="welcome-main-grid grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div class="min-w-0 overflow-hidden rounded-lg border">
          <div class="flex items-center justify-between border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t("welcome.quickConnections") }}</div>
          </div>
          <div class="divide-y">
            <button v-for="connection in recentConnections" :key="connection.id" class="flex w-full min-w-0 items-center gap-3 overflow-hidden px-4 py-3 text-left hover:bg-muted/40" @click="emit('open-connection-query', connection.id)">
              <DatabaseIcon :db-type="connectionIconType(connection)" class="h-4 w-4 shrink-0" />
              <span class="h-5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color || '#9ca3af' }" />
              <div class="min-w-0 flex-1">
                <TruncatedTextTooltip :text="connectionRedactedNameLabel(connection)" class="block text-sm font-medium" />
                <TruncatedTextTooltip :text="welcomeConnectionSubtitle(connection)" class="block text-xs text-muted-foreground" tooltip-class="max-w-[min(42rem,calc(100vw-2rem))] whitespace-pre-wrap break-all px-3 py-2 text-left leading-5" />
              </div>
              <FilePlus2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            <div v-if="recentConnections.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
              {{ t("sidebar.noConnections") }}
            </div>
          </div>
        </div>

        <div class="min-w-0 overflow-hidden rounded-lg border">
          <div class="border-b px-4 py-3">
            <div class="text-sm font-medium">{{ t("welcome.shortcuts") }}</div>
          </div>
          <div class="grid min-w-0 gap-1 p-2">
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('new-connection')">
              <Plus class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("toolbar.newConnection") }}</span>
            </button>
            <button v-if="canNewQuery" class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('new-query')">
              <FilePlus2 class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("toolbar.newQuery") }}</span>
            </button>
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('show-history')">
              <History class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("history.title") }}</span>
            </button>
            <button class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="emit('import-config')">
              <Download class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("sidebar.import") }}</span>
            </button>
            <div class="mt-2 min-w-0 overflow-hidden rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              <Search class="mr-1 inline h-3.5 w-3.5 shrink-0" />
              {{ t("welcome.tip") }}
            </div>
          </div>
        </div>
      </div>

      <div class="min-w-0 overflow-hidden rounded-lg border">
        <div class="flex items-center justify-between border-b px-4 py-3">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <History class="h-4 w-4 shrink-0" /> <span class="min-w-0 truncate">{{ t("welcome.sqlHistory") }}</span>
          </div>
        </div>
        <div class="divide-y">
          <button v-for="item in savedSqlHistoryItems" :key="item.id" class="flex w-full min-w-0 items-center gap-3 overflow-hidden px-4 py-3 text-left hover:bg-muted/40" @click="emit('open-saved-sql', item.id)">
            <History class="h-4 w-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ item.name }}</div>
              <div class="truncate text-xs text-muted-foreground">
                <span>{{ item.connectionName }}</span>
                <span v-if="item.database"> · {{ item.database }}</span>
                <span v-if="item.folderName"> · {{ item.folderName }}</span>
                <span v-if="item.openCount"> · {{ t("welcome.sqlHistoryOpenCount", { count: item.openCount }) }}</span>
              </div>
            </div>
            <FilePlus2 class="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div v-if="savedSqlHistoryItems.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
            {{ t("welcome.sqlHistoryEmpty") }}
          </div>
        </div>
      </div>

      <!-- MCP Integration Hint -->
      <div class="min-w-0 overflow-hidden rounded-lg border bg-muted/10 px-5 py-4">
        <div class="flex min-w-0 items-start gap-3">
          <Sparkles class="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ t("welcome.mcpTitle") }}</div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">
              {{ t("welcome.mcpDescription") }}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <code class="max-w-full break-all rounded bg-muted px-2 py-0.5 text-[11px] select-all">npx @dbx-app/mcp-server</code>
              <a href="#" class="text-xs text-primary hover:underline" @click.prevent="emit('open-mcp-guide')">{{ t("welcome.mcpLearnMore") }}</a>
            </div>
          </div>
        </div>
      </div>

      <!-- Project Info -->
      <div class="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/60">
        <span>DBX {{ appVersion ? "v" + appVersion : "" }}</span>
        <span>·</span>
        <a href="#" class="hover:text-foreground transition-colors" @click.prevent="emit('open-github')">GitHub</a>
      </div>
    </div>
  </div>
</template>

<style>
.welcome-content {
  max-width: 64rem;
}

.welcome-intro {
  max-width: 64rem;
}

.welcome-intro-hero {
  background: linear-gradient(135deg, color-mix(in srgb, var(--muted) 32%, var(--background)), var(--background) 58%, color-mix(in srgb, var(--primary) 8%, var(--background)));
}

@media (min-width: 640px) {
  .welcome-stats-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  }
}

@media (min-width: 1024px) {
  .welcome-main-grid {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr) !important;
  }
}
</style>
