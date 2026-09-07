<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight, Database, Folder, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConnectionConfig, SidebarLayout, SidebarOrderEntry } from "@/types/database";

type ScopeMode = "all" | "custom";
type ExecutionMode = "read_only" | "safe_write" | "high_risk_write";
type ResourceNode = GroupNode | ConnectionNode;

interface GroupNode {
  type: "group";
  id: string;
  name: string;
  pathNames: string[];
  pathIds: string[];
  depth: number;
  children: ResourceNode[];
}

interface ConnectionNode {
  type: "connection";
  id: string;
  connection: ConnectionConfig;
  pathIds: string[];
  depth: number;
}

const props = withDefaults(
  defineProps<{
    layout: SidebarLayout;
    connections: readonly ConnectionConfig[];
    allowedGroupIds: readonly string[];
    allowedConnectionIds: readonly string[] | null;
    groupPolicies?: readonly { groupId: string; readOnly: boolean; allowDangerousSql: boolean }[];
    connectionPolicies?: readonly { connectionId: string; readOnly: boolean; allowDangerousSql: boolean; executionModeConfigured?: boolean }[];
    disabled?: boolean;
    busy?: boolean;
  }>(),
  { disabled: false, busy: false },
);

const emit = defineEmits<{
  "update:scope": [value: { allowedGroupIds: string[]; allowedConnectionIds: string[] | null }];
  "set:group-policy": [groupId: string, mode: ExecutionMode | "inherit"];
  "set:connection-policy": [connectionId: string, mode: ExecutionMode | "inherit"];
}>();

const { t } = useI18n();
const search = ref("");
const expandedGroupIds = ref(new Set<string>());
const initializedExpansion = ref(false);

const scopeMode = computed<ScopeMode>(() => (props.allowedConnectionIds === null ? "all" : "custom"));
const connectionById = computed(() => new Map(props.connections.map((connection) => [connection.id, connection])));
const groupNameById = computed(() => new Map(props.layout.groups.map((group) => [group.id, group.name])));

function entryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] {
  return entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? [];
}

const resourceTree = computed<ResourceNode[]>(() => {
  const seenConnections = new Set<string>();
  const seenGroups = new Set<string>();
  const build = (entries: SidebarOrderEntry[], pathIds: string[], pathNames: string[], depth: number): ResourceNode[] =>
    entries.flatMap((entry): ResourceNode[] => {
      if (entry.type === "connection") {
        const connection = connectionById.value.get(entry.id);
        if (!connection || seenConnections.has(entry.id)) return [];
        seenConnections.add(entry.id);
        return [{ type: "connection", id: entry.id, connection, pathIds, depth }];
      }
      if (seenGroups.has(entry.id)) return [];
      const name = groupNameById.value.get(entry.id);
      if (!name) return [];
      seenGroups.add(entry.id);
      const nextPathIds = [...pathIds, entry.id];
      const nextPathNames = [...pathNames, name];
      return [{ type: "group", id: entry.id, name, pathIds: nextPathIds, pathNames: nextPathNames, depth, children: build(entryChildren(entry), nextPathIds, nextPathNames, depth + 1) }];
    });

  const nodes = build(props.layout.order, [], [], 0);
  for (const connection of props.connections) {
    if (!seenConnections.has(connection.id)) nodes.push({ type: "connection", id: connection.id, connection, pathIds: [], depth: 0 });
  }
  if (!initializedExpansion.value) {
    expandedGroupIds.value = new Set();
    initializedExpansion.value = true;
  }
  return nodes;
});

const selectedGroupIds = computed(() => new Set(props.allowedGroupIds));
const explicitConnectionIds = computed(() => new Set(props.allowedConnectionIds ?? []));

function selectedAncestor(node: ResourceNode): string | null {
  const ancestors = node.type === "group" ? node.pathIds.slice(0, -1) : node.pathIds;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (selectedGroupIds.value.has(ancestors[index])) return ancestors[index];
  }
  return null;
}

function groupLabel(groupId: string): string {
  const group = allGroups.value.get(groupId);
  return group?.pathNames.join(" / ") ?? groupId;
}

const allGroups = computed(() => {
  const result = new Map<string, GroupNode>();
  const visit = (nodes: ResourceNode[]) => {
    for (const node of nodes) {
      if (node.type !== "group") continue;
      result.set(node.id, node);
      visit(node.children);
    }
  };
  visit(resourceTree.value);
  return result;
});

function descendants(group: GroupNode): { groupIds: string[]; connectionIds: string[] } {
  const groupIds: string[] = [];
  const connectionIds: string[] = [];
  const visit = (nodes: ResourceNode[]) => {
    for (const node of nodes) {
      if (node.type === "connection") connectionIds.push(node.id);
      else {
        groupIds.push(node.id);
        visit(node.children);
      }
    }
  };
  visit(group.children);
  return { groupIds, connectionIds };
}

const effectiveConnectionIds = computed(() => {
  if (props.allowedConnectionIds === null) return new Set(props.connections.map((connection) => connection.id));
  const result = new Set(props.allowedConnectionIds);
  for (const groupId of props.allowedGroupIds) {
    const group = allGroups.value.get(groupId);
    if (!group) continue;
    for (const connectionId of descendants(group).connectionIds) result.add(connectionId);
  }
  return result;
});

const groupCoveredConnectionIds = computed(() => {
  const result = new Set<string>();
  for (const groupId of props.allowedGroupIds) {
    const group = allGroups.value.get(groupId);
    if (!group) continue;
    for (const connectionId of descendants(group).connectionIds) result.add(connectionId);
  }
  return result;
});

const directConnectionCount = computed(() => props.connections.filter((connection) => explicitConnectionIds.value.has(connection.id) && !groupCoveredConnectionIds.value.has(connection.id)).length);

const directGroupCount = computed(
  () =>
    props.allowedGroupIds.filter((groupId) => {
      const group = allGroups.value.get(groupId);
      return group && !selectedAncestor(group);
    }).length,
);

const summary = computed(() =>
  scopeMode.value === "all"
    ? t("settings.mcpResourceScopeAllSummary", { count: props.connections.length })
    : t("settings.mcpResourceScopeCustomSummary", {
        effective: props.connections.filter((connection) => effectiveConnectionIds.value.has(connection.id)).length,
        groups: directGroupCount.value,
        connections: directConnectionCount.value,
      }),
);

function searchableText(node: ResourceNode): string {
  if (node.type === "group") return node.pathNames.join(" ").toLocaleLowerCase();
  const connection = node.connection;
  return [connection.name, connection.db_type, connection.host, connection.port, connection.database, connection.id].filter(Boolean).join(" ").toLocaleLowerCase();
}

function subtreeMatches(node: ResourceNode, query: string): boolean {
  if (searchableText(node).includes(query)) return true;
  return node.type === "group" && node.children.some((child) => subtreeMatches(child, query));
}

const visibleRows = computed(() => {
  const rows: ResourceNode[] = [];
  const query = search.value.trim().toLocaleLowerCase();
  const visit = (nodes: ResourceNode[], includeAll = false) => {
    for (const node of nodes) {
      const ownMatch = !query || searchableText(node).includes(query);
      if (query && !includeAll && !subtreeMatches(node, query)) continue;
      rows.push(node);
      if (node.type === "group" && (query || expandedGroupIds.value.has(node.id))) visit(node.children, includeAll || ownMatch);
    }
  };
  visit(resourceTree.value);
  return rows;
});

function setScopeMode(mode: ScopeMode) {
  if (props.disabled || mode === scopeMode.value) return;
  if (mode === "all" && (props.allowedGroupIds.length > 0 || (props.allowedConnectionIds?.length ?? 0) > 0) && !window.confirm(t("settings.mcpResourceScopeAllConfirm"))) return;
  emit("update:scope", mode === "all" ? { allowedGroupIds: [], allowedConnectionIds: null } : { allowedGroupIds: [], allowedConnectionIds: [] });
}

function groupHasSelectedDescendant(group: GroupNode): boolean {
  const childIds = descendants(group);
  return childIds.groupIds.some((id) => selectedGroupIds.value.has(id)) || childIds.connectionIds.some((id) => explicitConnectionIds.value.has(id));
}

function toggleExpanded(groupId: string) {
  const next = new Set(expandedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroupIds.value = next;
}

function setGroupAllowed(group: GroupNode, allowed: boolean) {
  if (props.disabled || selectedAncestor(group)) return;
  const childIds = descendants(group);
  const nextGroups = props.allowedGroupIds.filter((id) => id !== group.id && (!allowed || !childIds.groupIds.includes(id)));
  const nextConnections = (props.allowedConnectionIds ?? []).filter((id) => !allowed || !childIds.connectionIds.includes(id));
  if (allowed) nextGroups.push(group.id);
  emit("update:scope", { allowedGroupIds: nextGroups, allowedConnectionIds: nextConnections });
}

function setConnectionAllowed(connectionId: string, allowed: boolean) {
  if (props.disabled) return;
  const next = new Set(props.allowedConnectionIds ?? []);
  if (allowed) next.add(connectionId);
  else next.delete(connectionId);
  emit("update:scope", { allowedGroupIds: [...props.allowedGroupIds], allowedConnectionIds: [...next] });
}

function policyMode(policy: { readOnly: boolean; allowDangerousSql: boolean; executionModeConfigured?: boolean } | undefined): ExecutionMode | "inherit" {
  if (!policy || policy.executionModeConfigured === false) return "inherit";
  if (policy.readOnly) return "read_only";
  return policy.allowDangerousSql ? "high_risk_write" : "safe_write";
}

function groupPolicyMode(groupId: string): ExecutionMode | "inherit" {
  return policyMode(props.groupPolicies?.find((policy) => policy.groupId === groupId));
}

function connectionPolicyMode(connectionId: string): ExecutionMode | "inherit" {
  return policyMode(props.connectionPolicies?.find((policy) => policy.connectionId === connectionId));
}
</script>

<template>
  <section class="overflow-hidden rounded-md border bg-background" :aria-busy="busy">
    <div class="flex flex-wrap items-start justify-between gap-3 p-3">
      <div class="min-w-0 space-y-1">
        <p class="text-sm font-medium">{{ t("settings.mcpResourceScopeTitle") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("settings.mcpResourceScopeDescription") }}</p>
      </div>
      <Badge variant="outline" class="max-w-full rounded-md font-normal">{{ summary }}</Badge>
    </div>

    <div class="grid grid-cols-2 gap-1 border-t bg-muted/40 p-1" role="radiogroup" :aria-label="t('settings.mcpResourceScopeTitle')">
      <Button type="button" role="radio" variant="ghost" class="h-9" :class="scopeMode === 'all' ? 'bg-background shadow-sm' : 'text-muted-foreground'" :aria-checked="scopeMode === 'all'" :disabled="disabled" @click="setScopeMode('all')">
        {{ t("settings.mcpScopeModeAll") }}
      </Button>
      <Button type="button" role="radio" variant="ghost" class="h-9" :class="scopeMode === 'custom' ? 'bg-background shadow-sm' : 'text-muted-foreground'" :aria-checked="scopeMode === 'custom'" :disabled="disabled" @click="setScopeMode('custom')">
        {{ t("settings.mcpResourceScopeModeCustom") }}
      </Button>
    </div>

    <template v-if="scopeMode === 'custom'">
      <div class="border-t p-2">
        <div class="relative">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" class="h-8 pl-8 text-xs" :placeholder="t('settings.mcpResourceScopeSearch')" :disabled="disabled" />
        </div>
      </div>
      <div v-if="visibleRows.length" class="max-h-80 overflow-auto border-t py-1" role="tree" :aria-label="t('settings.mcpResourceScopeTreeLabel')">
        <div
          v-for="node in visibleRows"
          :key="`${node.type}:${node.id}`"
          role="treeitem"
          class="flex min-h-9 items-center gap-2 px-2 text-xs hover:bg-muted/50"
          :aria-level="node.depth + 1"
          :aria-expanded="node.type === 'group' ? (search.trim() ? true : expandedGroupIds.has(node.id)) : undefined"
          :style="{ paddingLeft: `${8 + node.depth * 18}px` }"
        >
          <button v-if="node.type === 'group'" type="button" class="flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted" :aria-label="node.name" @click="toggleExpanded(node.id)">
            <ChevronDown v-if="search.trim() || expandedGroupIds.has(node.id)" class="size-3.5" />
            <ChevronRight v-else class="size-3.5" />
          </button>
          <span v-else class="size-6 shrink-0" />

          <input
            v-if="node.type === 'group'"
            type="checkbox"
            :checked="selectedGroupIds.has(node.id) || Boolean(selectedAncestor(node))"
            :indeterminate="!selectedGroupIds.has(node.id) && !selectedAncestor(node) && groupHasSelectedDescendant(node)"
            :disabled="disabled || Boolean(selectedAncestor(node))"
            :aria-checked="!selectedGroupIds.has(node.id) && !selectedAncestor(node) && groupHasSelectedDescendant(node) ? 'mixed' : selectedGroupIds.has(node.id) || Boolean(selectedAncestor(node))"
            :aria-label="node.pathNames.join(' / ')"
            @change="setGroupAllowed(node, ($event.target as HTMLInputElement).checked)"
          />
          <input v-else type="checkbox" :checked="explicitConnectionIds.has(node.id) || Boolean(selectedAncestor(node))" :disabled="disabled || Boolean(selectedAncestor(node))" :aria-label="node.connection.name" @change="setConnectionAllowed(node.id, ($event.target as HTMLInputElement).checked)" />

          <Folder v-if="node.type === 'group'" class="size-4 shrink-0 text-muted-foreground" />
          <Database v-else class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">{{ node.type === "group" ? node.name : node.connection.name }}</p>
            <p v-if="node.type === 'connection'" class="truncate font-mono text-[10px] text-muted-foreground">{{ node.connection.db_type }} · {{ node.connection.host || node.connection.database || node.id }}</p>
          </div>
          <select
            v-if="node.type === 'group' && selectedGroupIds.has(node.id)"
            :value="groupPolicyMode(node.id)"
            class="h-7 shrink-0 rounded border bg-background px-1.5 text-[11px]"
            :disabled="disabled || busy"
            @click.stop
            @change="emit('set:group-policy', node.id, ($event.target as HTMLSelectElement).value as ExecutionMode | 'inherit')"
          >
            <option value="inherit">{{ t("settings.mcpConnectionPolicyInherit") }}</option>
            <option value="read_only">{{ t("settings.mcpConnectionPolicyReadOnly") }}</option>
            <option value="safe_write">{{ t("settings.mcpConnectionPolicySafeWrite") }}</option>
            <option value="high_risk_write">{{ t("settings.mcpConnectionPolicyHighRiskWrite") }}</option>
          </select>
          <select
            v-if="node.type === 'connection' && (explicitConnectionIds.has(node.id) || Boolean(selectedAncestor(node)))"
            :value="connectionPolicyMode(node.id)"
            class="h-7 shrink-0 rounded border bg-background px-1.5 text-[11px]"
            :disabled="disabled || busy"
            @click.stop
            @change="emit('set:connection-policy', node.id, ($event.target as HTMLSelectElement).value as ExecutionMode | 'inherit')"
          >
            <option value="inherit">{{ selectedAncestor(node) ? t("settings.mcpGroupPolicyInherit") : t("settings.mcpConnectionPolicyInherit") }}</option>
            <option value="read_only">{{ t("settings.mcpConnectionPolicyReadOnly") }}</option>
            <option value="safe_write">{{ t("settings.mcpConnectionPolicySafeWrite") }}</option>
            <option value="high_risk_write">{{ t("settings.mcpConnectionPolicyHighRiskWrite") }}</option>
          </select>
          <Badge v-if="selectedAncestor(node)" variant="secondary" class="shrink-0 rounded font-normal">{{ t("settings.mcpResourceScopeInherited", { group: groupLabel(selectedAncestor(node)!) }) }}</Badge>
          <Badge v-else-if="node.type === 'group' && selectedGroupIds.has(node.id)" variant="outline" class="shrink-0 rounded font-normal">{{ t("settings.mcpResourceScopeDynamic") }}</Badge>
          <Badge v-else-if="node.type === 'group' && groupHasSelectedDescendant(node)" variant="secondary" class="shrink-0 rounded font-normal">{{ t("settings.mcpResourceScopePartial") }}</Badge>
          <Badge v-else-if="node.type === 'connection' && explicitConnectionIds.has(node.id)" variant="outline" class="shrink-0 rounded font-normal">{{ t("settings.mcpResourceScopeDirect") }}</Badge>
        </div>
      </div>
      <p v-else class="border-t px-3 py-8 text-center text-xs text-muted-foreground">{{ t("settings.mcpResourceScopeEmpty") }}</p>
      <p class="border-t px-3 py-2 text-[11px] text-muted-foreground">{{ t("settings.mcpResourceScopeHint") }}</p>
    </template>
  </section>
</template>
