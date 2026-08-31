import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("Nacos connection dialog layout", () => {
  it("presents implementation and version as one explicit connection profile", () => {
    expect(source).toContain("data-nacos-profile-selector");
    expect(source).toContain('v-for="profile in NACOS_CONNECTION_PROFILES"');
    expect(source).toContain("selectNacosConnectionProfile(profile.value)");
    expect(source).not.toContain("nacosVersionMode = 'auto'");
    expect(source).not.toContain("tryNacosDockerConsoleFallback");
    expect(source).not.toContain("dockerNacosConsoleFallbackUrl");
  });

  it("persists the explicit Nacos 3 Admin or Console API selection", () => {
    expect(source).toContain('const nacosApiPlane = ref<NacosApiPlane>("admin")');
    expect(source).toContain('config?.apiPlane || "admin"');
    expect(source).toContain('apiPlane: nacosImplementation.value === "nacos" && nacosVersionMode.value === "v3" ? nacosApiPlane.value : undefined');
    expect(source).toContain("nacos.nacosConsoleServiceAddressHint");
  });

  it("keeps the primary form focused on endpoints and authentication", () => {
    const mainStart = source.indexOf("data-nacos-profile-selector");
    const mainEnd = source.indexOf("<!-- Redis: host, port, user, password, ssl -->", mainStart);
    const main = source.slice(mainStart, mainEnd);

    expect(main).toContain("data-nacos-endpoint-section");
    expect(main).toContain("data-nacos-access-section");
    expect(main).toContain("data-nacos-advanced-hint");
    expect(main).toContain('t("nacos.nacosAdvancedHint")');
    expect(main).toContain("@click=\"configTab = 'advanced'\"");
    expect(main).toContain('v-model="nacosServerAddr"');
    expect(main).not.toContain('v-model="nacosManagedNamespacesText"');
    expect(main).not.toContain("data-nacos-namespace-access-scope");
    expect(main).not.toContain("data-nacos-ordinary-user-toggle");
    expect(main).not.toContain("nacosOrdinaryAccount");
    expect(main).toContain("nacosAuthKind === 'usernamePassword'");
    expect(main).not.toContain('v-model="nacosNamespace"');
    expect(main).toContain('t("nacos.nacosAuthHint")');
    expect(main).not.toContain('v-model="nacosMetricsMode"');
    expect(main).not.toContain('v-model.number="nacosPageSize"');
  });

  it("moves low-frequency and r-nacos console settings to the advanced tab", () => {
    const advancedStart = source.indexOf("data-nacos-advanced-settings");
    const advancedEnd = source.indexOf('v-if="showGaussdbConnectionMode"', advancedStart);
    const advanced = source.slice(advancedStart, advancedEnd);

    expect(advanced).not.toContain('v-model="nacosContextPathInput"');
    expect(advanced).not.toContain("配置上下文路径");
    expect(advanced).toContain('v-model="nacosContextPath"');
    expect(advanced).toContain('t("nacos.nacosContextPathHint")');
    expect(advanced).toContain('v-model="nacosMetricsMode"');
    expect(advanced).toContain('v-model="nacosRNacosConsoleAddr"');
    expect(advanced).toContain('v-if="nacosRNacosConsoleAddr.trim()"');
    expect(advanced).toContain('v-model="nacosHistoryEnabled"');
    expect(advanced).toContain('v-model="nacosTlsSkipVerify"');
    expect(advanced).toContain('v-model.number="nacosPageSize"');
  });

  it("documents product default ports instead of local Docker mappings", () => {
    expect(source).toContain('t("nacos.nacosServiceAddressHint")');
    expect(source).toContain('t("nacos.nacosMetricsHint")');
    expect(source).not.toContain("DBX 不需要配置该地址");
    const mainStart = source.indexOf("data-nacos-profile-selector");
    const mainEnd = source.indexOf("<!-- Redis: host, port, user, password, ssl -->", mainStart);
    expect(source.slice(mainStart, mainEnd)).not.toContain("data-nacos-managed-namespaces");
    expect(source.slice(mainStart, mainEnd)).not.toContain('placeholder="http://127.0.0.1:8080"');
    expect(source).not.toContain("http://127.0.0.1:8010");
    expect(source).not.toContain("http://127.0.0.1:8818");
  });

  it("uses a dedicated namespace selector instead of the database selector", () => {
    expect(source).toContain("t(nacosNamespacePickerTitleKey)");
    expect(source).toContain('"nacos.nacosDetectAccessibleNamespaces"');
    expect(source).toContain("openVisibleNacosNamespacesPicker");
    expect(source).toContain("loadReadableNacosNamespaces(draftId, api)");
    expect(source).toContain("showVisibleNacosNamespacesDialog");
    expect(source).toContain('v-model="visibleNacosNamespaceAccessMode"');
    expect(source).toContain('TabsTrigger value="automatic"');
    expect(source).toContain('TabsTrigger v-if="canDetectNacosNamespaceAccess" value="manual"');
    expect(source).toContain('v-model="nacosManagedNamespacesText"');
    expect(source).not.toContain("!isNacosV3AdminPlane.value");
    expect(source).toContain('visibleNacosNamespaceAccessMode.value === "manual"');
  });

  it("guides namespace listing permission failures to manual scope entry", () => {
    expect(source).toContain("function isNacosNamespaceListingPermissionError(error: unknown): boolean");
    expect(source).toContain("NACOS_ERROR\\[rnacosNamespaceDirectoryUnavailable\\]");
    expect(source).toContain("NACOS_ERROR\\[(?:v3ManagedNamespacesRequired|managedNamespacesRequired)\\]");
    expect(source).toContain("/\\/v3\\/(?:admin|console)\\/core\\/namespace\\/list/");
    expect(source).toContain("visibleNacosNamespaceListingPermissionDenied.value = isNacosNamespaceListingPermissionError(e)");
    expect(source).toContain('t("nacos.nacosManagedNamespacesRequired")');
    expect(source).toContain('v-else-if="visibleNacosNamespaceListingPermissionDenied"');
    expect(source).toContain("@click=\"visibleNacosNamespaceAccessMode = 'manual'\"");
  });

  it("resolves unique manually entered namespace names to their Nacos IDs", () => {
    expect(source).toContain("function normalizeManualNacosNamespaceNames(namespaces: string[], availableNamespaces: NacosNamespaceInfo[]): string[]");
    expect(source).toContain("matchingNames.length === 1 ? matchingNames[0] : namespace");
    expect(source).toContain("async function resolveManualNacosNamespaceNames(namespaces: string[]): Promise<string[]>");
    expect(source).toContain("managedNamespaces: undefined");
    expect(source).toContain(": await resolveManualNacosNamespaceNames(manualNamespaces)");
  });

  it("distinguishes the manual namespace input for the V3 Admin and Console API planes", () => {
    expect(source).toContain("const isNacosV3ConsolePlane = computed(");
    expect(source).toContain('isNacosV3AdminPlane.value ? "nacos.nacosManagedNamespaces" : "nacos.nacosManagedNamespacesNameOrId"');
    expect(source).toContain('isNacosV3AdminPlane.value ? "nacos.nacosManagedNamespacesIdPlaceholder" : "nacos.nacosManagedNamespacesPlaceholder"');
    expect(source).toContain('if (isNacosV3AdminPlane.value) return "nacos.nacosV3AdminManagedNamespacesHint"');
    expect(source).toContain('if (isNacosV3ConsolePlane.value) return "nacos.nacosV3ConsoleManagedNamespacesHint"');
    expect(source).toContain('v-if="isNacosV3AdminPlane" class="flex gap-2 rounded-md border border-amber-500/30');
    expect(source).toContain('isNacosV3AdminPlane.value || nacosImplementation.value === "rnacos"');
    expect(source).toContain("? manualNamespaces");
    expect(source).toContain(": await resolveManualNacosNamespaceNames(manualNamespaces)");
  });

  it("opens namespace access setup instead of showing a save validation error", () => {
    expect(source).toContain("if (!hasNacosNamespaceScopeForSave()) {");
    expect(source).toContain("await openVisibleNacosNamespacesPicker();");
    expect(source).not.toContain('message: t("nacos.nacosNamespaceScopeRequiredBeforeSave")');
  });

  it("stores automatic full access as a dynamic namespace scope", () => {
    expect(source).toContain("const nacosDynamicAllNamespaces = ref(false)");
    expect(source).toContain("const useDynamicAll = selectsEntireReadableList && visibleNacosNamespaceDynamicAllSupported.value");
    expect(source).toContain("const readableSet = new Set(readableIds.map(nacosNamespaceIdentity))");
    expect(source).toContain("readableSet.size === sidebarSet.size");
    expect(source).toContain("form.value.visible_databases = useDynamicAll ? undefined : selected");
    expect(source).toContain("nacosDynamicAllNamespaces.value = useDynamicAll");
    expect(source).toContain("function showAllVisibleNacosNamespaces()");
  });

  it("uses namespaces when scoping Nacos production safeguards", () => {
    expect(source).toContain('form.value.db_type === "nacos"');
    expect(source).toContain("production.allNamespaces");
    expect(source).toContain("production.namespacePickerTitle");
    expect(source).toContain("loadReadableNacosNamespaces(connectionId, api)");
    expect(source).toContain("nacosNamespaceIdentity(name)");
  });
});
