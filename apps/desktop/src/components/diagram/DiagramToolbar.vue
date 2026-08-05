<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Download, Link2, Loader2, Maximize2, Minimize2, Network, Plus, RefreshCw, Search, Table2, Upload, X, ZoomIn, ZoomOut, LayoutGrid } from "@lucide/vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import type { ConnectionConfig } from "@/types/database";
import type { DiagramExportFormat } from "@/lib/export/diagramFormats";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  database: string;
  schema: string;
  databases: string[];
  schemas: string[];
  sqlConnections: ConnectionConfig[];
  selectedConnection: ConnectionConfig | undefined;
  isSchemaAware: boolean;
  loadingDatabases: boolean;
  loadingSchemas: boolean;
  loadingDiagram: boolean;
  diagramReady: boolean;
  tablesCount: number;
  relationshipsCount: number;
  customRelationshipCount: number;
  matchRelationshipCount: number;
  diagramMode: "table" | "engineering";
  tableSearch: string;
  showMatchPanel: boolean;
  showLayersPanel: boolean;
  showAllTables: boolean;
  focusTableName: string;
  generatedJoinSql: string;
  isFullscreen?: boolean;
  draftTableCount?: number;
  canCreateTable?: boolean;
  canSyncToDatabase?: boolean;
}>();

const emit = defineEmits<{
  (e: "set-connection", value: string): void;
  (e: "set-database", value: string): void;
  (e: "set-schema", value: string): void;
  (e: "update:table-search", value: string): void;
  (e: "set-diagram-mode", value: "table" | "engineering"): void;
  (e: "toggle-match-panel"): void;
  (e: "toggle-layers-panel"): void;
  (e: "copy-join-sql"): void;
  (e: "toggle-show-all-tables"): void;
  (e: "export-format", format: DiagramExportFormat): void;
  (e: "refresh"): void;
  (e: "zoom-out"): void;
  (e: "zoom-in"): void;
  (e: "toggle-fullscreen"): void;
  (e: "auto-layout"): void;
  (e: "create-table"): void;
  (e: "sync-to-database"): void;
}>();

const EXPORT_FORMATS: DiagramExportFormat[] = ["svg", "png", "json", "dbml", "mermaid"];

function exportFormatLabel(format: DiagramExportFormat): string {
  switch (format) {
    case "svg":
      return t("diagram.exportSvg");
    case "png":
      return t("diagram.exportPng");
    case "json":
      return t("diagram.exportJson");
    case "dbml":
      return t("diagram.exportDbml");
    case "mermaid":
      return t("diagram.exportMermaid");
  }
}

function connectionIconType(id: string) {
  const config = props.sqlConnections.find((c) => c.id === id);
  return config?.driver_profile || config?.db_type || "mysql";
}
</script>

<template>
  <div class="flex items-center gap-2 border-b px-3 py-2 shrink-0 overflow-x-auto">
    <Select :model-value="connectionId" @update:model-value="(value: any) => emit('set-connection', String(value))">
      <SelectTrigger class="h-8 w-48 text-xs">
        <div v-if="connectionId" class="flex min-w-0 items-center gap-2">
          <DatabaseIcon :db-type="connectionIconType(connectionId)" class="w-3.5 h-3.5 shrink-0" />
          <span class="truncate">{{ selectedConnection?.name }}</span>
        </div>
        <SelectValue v-else :placeholder="t('diagram.selectConnection')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">
          <div class="flex min-w-0 items-center gap-2">
            <DatabaseIcon :db-type="connection.driver_profile || connection.db_type" class="w-3.5 h-3.5 shrink-0" />
            <ConnectionGroupBadge :connection-id="connection.id" />
            <span class="min-w-0 flex-1 truncate">{{ connection.name }}</span>
          </div>
        </SelectItem>
      </SelectContent>
    </Select>

    <Select :model-value="database" :disabled="!databases.length || loadingDatabases" @update:model-value="(value: any) => emit('set-database', String(value))">
      <SelectTrigger class="h-8 w-44 text-xs">
        <SelectValue :placeholder="loadingDatabases ? t('common.loading') : t('diagram.selectDatabase')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="db in databases" :key="db" :value="db">{{ db }}</SelectItem>
      </SelectContent>
    </Select>

    <Select v-if="isSchemaAware" :model-value="schema" :disabled="!schemas.length || loadingSchemas" @update:model-value="(value: any) => emit('set-schema', String(value))">
      <SelectTrigger class="h-8 w-40 text-xs">
        <SelectValue :placeholder="loadingSchemas ? t('common.loading') : t('diagram.selectSchema')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="name in schemas" :key="name" :value="name">{{ name }}</SelectItem>
      </SelectContent>
    </Select>

    <div class="relative min-w-40 flex-1">
      <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input :value="tableSearch" @input="(e: Event) => emit('update:table-search', (e.target as HTMLInputElement).value)" class="h-8 pl-7 pr-9 text-xs" :placeholder="t('diagram.searchTables')" />
      <button v-if="tableSearch" type="button" class="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-muted-foreground/20 hover:bg-muted-foreground/40 flex items-center justify-center transition-colors" @click="emit('update:table-search', '')">
        <X class="h-3 w-3 text-muted-foreground" />
      </button>
    </div>

    <div class="flex h-8 shrink-0 items-center overflow-hidden rounded-md border bg-background">
      <Button variant="ghost" size="sm" class="h-8 rounded-none px-2 text-xs" :class="diagramMode === 'table' ? 'bg-accent' : ''" @click="emit('set-diagram-mode', 'table')">
        <Table2 class="mr-1 h-3.5 w-3.5" />
        {{ t("diagram.tableMode") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-8 rounded-none border-l px-2 text-xs" :class="diagramMode === 'engineering' ? 'bg-accent' : ''" @click="emit('set-diagram-mode', 'engineering')">
        <Network class="mr-1 h-3.5 w-3.5" />
        {{ t("diagram.engineeringMode") }}
      </Button>
    </div>

    <Button variant="outline" size="sm" class="h-8 px-2 text-xs" :disabled="!diagramReady || canCreateTable === false" :title="canCreateTable === false ? t('diagram.createTableNotSupported') : t('diagram.createTable')" @click="emit('create-table')">
      <Plus class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.createTable") }}
    </Button>

    <Button
      variant="outline"
      size="sm"
      class="h-8 px-2 text-xs"
      :disabled="!diagramReady || !(draftTableCount ?? 0) || canSyncToDatabase === false"
      :title="canSyncToDatabase === false ? t('diagram.structureSyncNotSupported') : t('diagram.syncToDatabase')"
      :class="(draftTableCount ?? 0) > 0 ? 'bg-primary/10 border-primary text-primary' : ''"
      @click="emit('sync-to-database')"
    >
      <Upload class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.syncToDatabase") }}
      <Badge v-if="(draftTableCount ?? 0) > 0" variant="secondary" class="ml-1 h-4 px-1 text-[10px]">{{ draftTableCount }}</Badge>
    </Button>

    <Button variant="outline" size="sm" class="h-8 px-2 text-xs" :disabled="tablesCount === 0" :title="t('diagram.modelRelationships')" :class="showMatchPanel ? 'bg-primary/10 border-primary text-primary' : ''" @click="emit('toggle-match-panel')">
      <Link2 class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.modelRelationships") }}
    </Button>

    <Button variant="outline" size="sm" class="h-8 px-2 text-xs" :disabled="!diagramReady" :title="t('diagram.layers')" :class="showLayersPanel ? 'bg-primary/10 border-primary text-primary' : ''" @click="emit('toggle-layers-panel')">
      <LayoutGrid class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.layers") }}
    </Button>

    <Button variant="outline" size="sm" class="h-8 px-2 text-xs" :disabled="tablesCount === 0" :title="t('diagram.autoLayout')" @click="emit('auto-layout')">
      <LayoutGrid class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.autoLayout") }}
    </Button>

    <Button variant="outline" size="sm" class="h-8 px-2 text-xs" :disabled="!generatedJoinSql.trim()" :title="t('diagram.copyJoinSql')" @click="emit('copy-join-sql')">
      <Copy class="mr-1 h-3.5 w-3.5" />
      {{ t("diagram.copyJoinSql") }}
    </Button>

    <Button v-if="focusTableName && tablesCount > 0" variant="outline" size="sm" class="h-8 px-2 text-xs" @click="emit('toggle-show-all-tables')">
      {{ showAllTables ? t("diagram.relatedTables") : t("diagram.allTables") }}
    </Button>

    <Badge variant="secondary" class="h-6 shrink-0">
      {{ t("diagram.tablesCount", { count: tablesCount }) }}
    </Badge>
    <Badge variant="secondary" class="h-6 shrink-0">
      {{ t("diagram.relationshipsCount", { count: relationshipsCount }) }}
    </Badge>
    <Badge v-if="matchRelationshipCount > 0" variant="outline" class="h-6 shrink-0">
      {{ t("diagram.matchRelationshipsCount", { count: matchRelationshipCount }) }}
    </Badge>
    <Badge v-if="customRelationshipCount > 0" variant="outline" class="h-6 shrink-0">
      {{ t("diagram.customRelationshipsCount", { count: customRelationshipCount }) }}
    </Badge>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="loadingDiagram || tablesCount === 0" :title="t('diagram.export')">
          <Download class="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-44">
        <DropdownMenuItem v-for="format in EXPORT_FORMATS" :key="format" @click="emit('export-format', format)">
          {{ exportFormatLabel(format) }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="!diagramReady || loadingDiagram" :title="t('diagram.refresh')" @click="emit('refresh')">
      <Loader2 v-if="loadingDiagram" class="h-4 w-4 animate-spin" />
      <RefreshCw v-else class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="diagramMode === 'engineering' || tablesCount === 0" :title="t('diagram.zoomOut')" @click="emit('zoom-out')">
      <ZoomOut class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="diagramMode === 'engineering' || tablesCount === 0" :title="t('diagram.zoomIn')" @click="emit('zoom-in')">
      <ZoomIn class="h-4 w-4" />
    </Button>
    <Button variant="ghost" size="icon" class="h-8 w-8" :title="isFullscreen ? t('diagram.exitFullscreen') : t('diagram.fullscreen')" @click="emit('toggle-fullscreen')">
      <Minimize2 v-if="isFullscreen" class="h-4 w-4" />
      <Maximize2 v-else class="h-4 w-4" />
    </Button>
  </div>
</template>
