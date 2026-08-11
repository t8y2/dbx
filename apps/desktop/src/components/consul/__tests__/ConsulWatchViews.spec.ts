import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const services = readFileSync(new URL("../ConsulServices.vue", import.meta.url), "utf8");
const health = readFileSync(new URL("../ConsulHealth.vue", import.meta.url), "utf8");
const overview = readFileSync(new URL("../ConsulOverview.vue", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../ConsulSessions.vue", import.meta.url), "utf8");
const scope = readFileSync(new URL("../ConsulScope.vue", import.meta.url), "utf8");
const keyBrowser = readFileSync(new URL("../ConsulKeyBrowser.vue", import.meta.url), "utf8");
const mesh = readFileSync(new URL("../ConsulMesh.vue", import.meta.url), "utf8");
const tools = readFileSync(new URL("../ConsulTools.vue", import.meta.url), "utf8");
const operator = readFileSync(new URL("../ConsulOperator.vue", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../ConsulWorkspace.vue", import.meta.url), "utf8");
const kvBrowser = readFileSync(new URL("../../kv/KvKeyBrowser.vue", import.meta.url), "utf8");

describe("Consul Catalog and Health watch views", () => {
  it("watches both service and node Catalog resources and cancels them on teardown", () => {
    for (const target of ["catalogServices", "catalogServiceNodes", "catalogNodes", "catalogNodeServices"]) {
      expect(services).toContain(`kind: "${target}"`);
    }
    expect(services).toMatch(/onBeforeUnmount\(\(\) => \{\s*void stopWatches\(\);\s*\}\);/);
    expect(services).toContain("switchBrowseMode");
  });

  it("supports state, node, and service Health resources with a scoped watch", () => {
    for (const target of ["healthState", "healthNode", "healthServiceInstances"]) {
      expect(health).toContain(`kind: "${target}"`);
    }
    expect(health).toContain('browseMode = ref<"state" | "node" | "service">');
    expect(health).toMatch(/onBeforeUnmount\(\(\) => \{\s*void stopWatch\(\);\s*\}\);/);
    expect(health).toContain("selectedCheck");
    expect(health).toContain("selectedCheck.Definition");
  });

  it("filters and paginates Health results without querying on every target keystroke", () => {
    for (const state of ["browseNameDraft", "keywordFilter", "statusFilter", "typeFilter"]) {
      expect(health).toContain(`const ${state} = ref(`);
    }
    for (const collection of ["filteredChecks", "filteredLocalChecks", "pagedChecks", "pagedLocalChecks", "pagedServiceInstances"]) {
      expect(health).toContain(`const ${collection} = computed(`);
    }
    expect(health).toContain('v-model="browseNameDraft"');
    expect(health).toContain('@keydown.enter="applyBrowseTarget"');
    expect(health).toContain("t('consul.ui.searchHealthChecks')");
    expect(health).toContain("<ConsulListPagination");
    expect(health).not.toContain("watch([state, browseMode, browseName]");
  });

  it("shows Catalog metadata and independent Overview probe states", () => {
    expect(services).toContain("item.NodeMeta");
    expect(services).toContain("item.ServiceMeta");
    expect(services).toContain("nodeServices?.Node.NodeMeta");
    for (const state of ["loading", "ready", "forbidden", "unsupported", "error"]) {
      expect(overview).toContain(`"${state}"`);
    }
    expect(overview).toContain("probeStates[key]");
  });

  it("binds Session renew to connection and scope lifecycle and exposes lock indexes", () => {
    expect(sessions).toContain("connectionActive");
    expect(sessions).toContain("consulStore.generation");
    expect(sessions).toContain("currentScopeKey()");
    expect(sessions).toContain("clearTimeout(renewTimer)");
    expect(sessions).toContain("item.lockIndex");
    expect(sessions).toContain("session.NodeChecks");
    expect(sessions).toContain("session.ServiceChecks");
    expect(sessions).toContain("!isTtlSession(session)");
    expect(sessions).toContain("ConsulListPagination");
    expect(sessions).toContain("filteredSessions");
    expect(sessions).toContain("await inspectLockKey()");
    expect(sessions).toContain("expectedModifyIndex: lockInspection.value.modifyIndex");
    expect(sessions).toContain("heldKeys[session.ID].complete");
    expect(sessions).toContain("value.items.map(normalizeConsulSession)");
    expect(sessions).toContain("withUiTimeout(api.consulSessions(props.connectionId))");
  });

  it("renders the complete Enterprise delete impact inventory", () => {
    for (const resource of ["kvKeys", "healthChecks", "sessions", "intentions", "peerings", "aclTokens", "aclPolicies", "aclRoles", "aclAuthMethods", "aclBindingRules"]) {
      expect(scope).toContain(`value.${resource}`);
    }
    expect(scope).toContain("impact.filteredByAcls");
    expect(scope).toContain("impact.unavailableResources");
  });

  it("offers both Agent service maintenance transitions", () => {
    expect(services).toContain("maintenance(service.ID, true)");
    expect(services).toContain("maintenance(service.ID, false)");
    expect(services).toContain('t("consul.ui.enableMaintenance")');
    expect(services).toContain('t("consul.ui.disableMaintenance")');
    expect(services).toContain('v-if="canAgentWrite"');
    expect(services).toContain('t("consul.ui.agentWriteDisabledHint"');
  });

  it("keeps Catalog browsing searchable and separates readable Catalog data from Agent actions", () => {
    expect(services).toContain('const browseFilter = ref("");');
    expect(services).toContain("const filteredServiceNames");
    expect(services).toContain("const filteredNodeNames");
    expect(services).toContain("const localServiceItems");
    expect(services).toContain("const filteredLocalServiceItems");
    expect(services).toContain("<Search class=");
    expect(services).toContain("selectedLocalService?.ID === service.ID");
    expect(services).toContain('<Button v-for="name in pagedServiceNames"');
    expect(services).not.toContain("services[name]?.join(', ')");
    expect(services).toContain('@click="selectService(name)"');
    expect(services).toContain('@click="selectNode(name)"');
    expect(services).toContain("Catalog browsing must remain responsive even when an Agent endpoint is slow or unavailable.");
    expect(services).toContain("void loadAgentData(current);");
    expect(services).toContain("t('consul.ui.searchAllServices')");
    expect(services).toContain("t('consul.ui.searchLocalServices')");
  });

  it("loads Consul tools independently and exposes complete event and result details", () => {
    expect(tools).toContain('const activeTab = ref<ToolTab>("queries")');
    for (const loader of ["loadQueries", "loadEvents", "loadCoordinates"]) {
      expect(tools).toContain(`async function ${loader}()`);
    }
    for (const errorState of ["queryError", "eventError", "coordinateError"]) {
      expect(tools).toContain(`const ${errorState} = ref("")`);
    }
    expect(tools).not.toContain("Promise.allSettled");
    expect(tools).toContain('v-model="eventNodeFilter"');
    expect(tools).toContain('v-model="eventServiceFilter"');
    expect(tools).toContain('v-model="eventTagFilter"');
    expect(tools).toContain("queryResult.Nodes");
    expect(tools).toContain("item.Coord.Adjustment");
    expect(tools).toContain("item.Coord.Height");
  });

  it("paginates every potentially large service collection before rendering", () => {
    for (const collection of ["pagedServiceNames", "pagedNodeNames", "pagedCatalogInstances", "pagedNodeServices", "pagedLocalServices"]) {
      expect(services).toContain(`const ${collection} = computed(() => paginateConsulItems(`);
      expect(services).toContain(`v-for="${collection === "pagedCatalogInstances" ? "item" : collection.includes("Names") ? "name" : "service"} in ${collection}"`);
    }
    expect(services).toContain("<ConsulListPagination");
    expect(services).toContain(':page-size="CONSUL_LIST_PAGE_SIZE"');
  });

  it("gates Agent writes on an explicit target that matches the Agent node", () => {
    for (const source of [services, health]) {
      expect(source).toContain("config.agentTarget || config.agent_target");
      expect(source).toContain("consulAgentWriteTargetSafe(store.getConfig(props.connectionId), identity.value?.node)");
      expect(source).toContain(':disabled="!canAgentWrite"');
    }
  });

  it("supports exact-Key and prefix KV watches and exposes batch atomicity", () => {
    expect(keyBrowser).toContain('watchMode = ref<"key" | "prefix">("prefix")');
    expect(keyBrowser).toContain('prefix: watchMode.value === "prefix"');
    expect(keyBrowser).toContain(':on-watch-key="watchSelectedKey"');
    expect(keyBrowser).toContain("transferReport.atomic");
    expect(keyBrowser).toContain("deleteReport.atomic");
    expect(keyBrowser).toContain("row.opIndex");
  });

  it("keeps the Key prefix search first and groups enhanced Consul KV actions after a divider", () => {
    expect(keyBrowser).toContain("<template #toolbar-trailing>");
    expect(keyBrowser).not.toContain('v-model="watchPrefix" class="h-7 w-52 text-xs"');
    expect(kvBrowser).toContain('<slot name="toolbar-trailing" />');
    expect(kvBrowser).toContain('class="mx-1 h-6 w-px shrink-0 bg-border"');
  });

  it("keeps exact-Key watch start and stop beside the selected Key", () => {
    expect(keyBrowser).toContain(":watch-active-key=\"watchRunning && watchMode === 'key' ? watchPrefix : null\"");
    expect(keyBrowser).toContain('watchMode.value === "key" && watchPrefix.value === route.key');
    expect(keyBrowser).toContain("await stopWatch();\n    return;");
  });

  it("serializes search progress polling and invalidates stale pollers", () => {
    expect(keyBrowser).toContain("searchProgressSequence");
    expect(keyBrowser).toContain("searchProgressTimer = setTimeout");
    expect(keyBrowser).toContain("sequence === searchProgressSequence");
    expect(keyBrowser).not.toContain("searchProgressTimer = setInterval");
  });

  it("uses a compact Session-protection card and a metadata grid for Consul KV details", () => {
    expect(kvBrowser).toContain('labels.sessionProtected || "Session protected"');
    expect(kvBrowser).toContain('labels.sessionProtectedHint || "Editing and deletion are disabled to protect this distributed lock."');
    expect(kvBrowser).toContain("copyText(selectedMetadata?.session)");
    expect(kvBrowser).toContain('<dl class="grid grid-cols-2 divide-x divide-y sm:grid-cols-3">');
    expect(kvBrowser).not.toContain('["Session", metadata?.session]');
  });

  it("exports the current Consul full-text search result set", () => {
    expect(keyBrowser).toContain("async function exportSearchResults()");
    expect(keyBrowser).toContain('format: "dbx-consul-kv-search-results"');
    expect(keyBrowser).toContain('t("consul.tools.exportSearchResults")');
  });

  it("carries full-text match metadata into the selected Consul KV detail", () => {
    expect(keyBrowser).toContain("const searchHighlight = ref<{");
    expect(keyBrowser).toContain("matchesKey: result.matchesKey");
    expect(keyBrowser).toContain(':search-highlight="searchHighlight"');
  });

  it("offers the same server-backed prefix completion for export, migration, and prefix deletion", () => {
    expect(keyBrowser).toContain('type PrefixSuggestionTarget = "export" | "migration" | "delete"');
    expect(keyBrowser).toContain("const prefixSuggestionDebounceMs = 300;");
    expect(keyBrowser).toContain("function schedulePrefixSuggestions(target: PrefixSuggestionTarget, value: string)");
    expect(keyBrowser).toContain("schedulePrefixSuggestions(target, suggestion.key);");
    expect(keyBrowser).toContain('event.key !== "Enter" && event.key !== "Tab"');
    expect(keyBrowser).toContain("prefixSuggestionIndex.value >= 0 ? prefixSuggestionIndex.value : 0");
    expect(keyBrowser).toContain("@input=\"schedulePrefixSuggestions('export'");
    expect(keyBrowser).toContain("@input=\"schedulePrefixSuggestions('migration'");
    expect(keyBrowser).toContain("@input=\"schedulePrefixSuggestions('delete'");
    expect(keyBrowser).toContain("@keydown=\"onPrefixSuggestionKeydown('migration', $event)\"");
    expect(keyBrowser).toContain("@keydown=\"onPrefixSuggestionKeydown('delete', $event)\"");
    expect(keyBrowser).toContain('<PopoverContent align="start" side="bottom" :collision-padding="12"');
    expect(keyBrowser).toContain("max-h-[var(--reka-popover-content-available-height)]");
  });

  it("marks the specific locked Key and Session in a prefix-delete preview", () => {
    expect(keyBrowser).toContain("'session' in row && row.session ? 'bg-destructive/5' : ''");
    expect(keyBrowser).toContain('v-if="\'session\' in row && row.session" variant="destructive"');
    expect(keyBrowser).toContain('t("consul.ui.sessionValue", { id: row.session })');
  });

  it("shows the server-provided reason when a prefix-delete operation fails", () => {
    expect(keyBrowser).toContain("'message' in row && row.message");
    expect(keyBrowser).toContain(':title="row.message"');
  });

  it("opens the safe prefix-delete preview from a Consul directory context menu", () => {
    expect(keyBrowser).toContain(':on-delete-prefix="openDeletePrefix"');
    expect(keyBrowser).toContain('function openDeletePrefix(prefix = "")');
    expect(keyBrowser).not.toContain('@click="openDeletePrefix"');
    expect(kvBrowser).toContain("if (nodeIsExpandable(node) && props.onDeletePrefix)");
    expect(kvBrowser).toContain("action: () => props.onDeletePrefix?.(nodePath(node))");
  });

  it("preserves Exported Services CAS state and capability-gates advanced writes", () => {
    expect(mesh).toContain('consulMeshConfigList(props.connectionId, "exported-services")');
    expect(mesh).toContain("editingExported.value?.modifyIndex || 0");
    expect(tools).toContain("canWriteQueries");
    expect(tools).toContain("canFireEvents");
    expect(operator).toContain("keyringWriteVisible");
    expect(operator).toContain("props.capabilities?.operatorKeyring");
  });

  it("keeps workspace actions fixed while only the tab strip scrolls horizontally", () => {
    expect(workspace).toContain("min-w-0 flex-1 overflow-x-auto overflow-y-hidden");
    expect(workspace).toContain("h-8 w-max min-w-max justify-start");
    expect(workspace).toContain('class="h-7 flex-none gap-1.5 px-3 text-xs"');
    expect(workspace).toContain("flex h-11 shrink-0 items-center gap-2 border-b px-3");
    expect(workspace).toContain('class="flex shrink-0 items-center gap-1"');
  });

  it("starts with KV and keeps the cluster overview as a sidebar surface", () => {
    expect(workspace).toContain('const activeTab = ref<WorkspaceTab>("kv");');
    expect(workspace).not.toContain('<TabsTrigger value="overview"');
    expect(workspace).not.toContain('<TabsContent value="overview"');
  });

  it("shows the real datacenter by default and gates advanced scope controls by capability", () => {
    expect(workspace).toContain("const resolvedDatacenter = computed(() => activeScope.value.datacenter || capabilities.value?.datacenter");
    expect(workspace).toContain('const enterpriseScopeAvailable = computed(() => capabilities.value?.namespaces === "supported" || capabilities.value?.partitions === "supported");');
    expect(workspace).toContain('v-if="enterpriseScopeAvailable"');
    expect(workspace).toContain('v-if="datacenterOptions.length > 1" v-model="scopeDraft.datacenter"');
  });

  it("hides only disabled ACLs and Enterprise-only scope tabs", () => {
    expect(workspace).toContain('const aclVisible = computed(() => capabilities.value?.acl !== "disabled");');
    expect(workspace).toContain("const scopeTabVisible = computed(() => enterpriseScopeAvailable.value);");
    expect(workspace).toContain('v-if="aclVisible" value="acl"');
    expect(workspace).toContain('v-if="scopeTabVisible" value="scope"');
    expect(workspace).toContain('if (activeTab.value === "acl" && !aclVisible.value) activeTab.value = "kv";');
  });
});
