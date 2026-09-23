// @vitest-environment happy-dom

import { createApp, nextTick, type App, type ComponentPublicInstance } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, PluginRepositoryCatalogResult } from "@/types/database";
import type { MarketplacePluginListing } from "@/lib/plugins/pluginMarketplace";
import { COMPONENT_PLUGINS_UPDATED_EVENT, COMPONENT_UPDATES_CHANGED_EVENT } from "@/lib/updates/componentUpdateEvents";

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  listPluginTrustedKeys: vi.fn(),
  listPluginRepositories: vi.fn(),
  fetchPluginMarketplaceCatalogs: vi.fn(),
  installMarketplacePlugin: vi.fn(),
  installPluginPackage: vi.fn(),
  installPluginPackageFromUrl: vi.fn(),
  uninstallPlugin: vi.fn(),
  rollbackPlugin: vi.fn(),
  savePluginRepository: vi.fn(),
  removePluginRepository: vi.fn(),
  savePluginTrustedKey: vi.fn(),
  removePluginTrustedKey: vi.fn(),
  toast: vi.fn(),
  isTauriRuntime: vi.fn(),
  refreshPluginWorkbenches: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [] }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: mocks.isTauriRuntime }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  return { useI18n: () => ({ locale: ref("en"), t: (key: string, values = {}) => `${key}:${JSON.stringify(values)}` }) };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/label", async () => ({ Label: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Label", "label") }));
vi.mock("@/components/ui/switch", async () => ({ Switch: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Switch") }));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Select");
  return { Select: stub, SelectContent: stub, SelectItem: stub, SelectTrigger: stub, SelectValue: stub };
});
vi.mock("@/components/ui/tabs", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Tabs");
  return { Tabs: stub, TabsContent: stub, TabsList: stub, TabsTrigger: stub };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Tooltip");
  return { Tooltip: stub, TooltipContent: stub, TooltipTrigger: stub };
});
vi.mock("@/components/plugins/PluginIcon.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("PluginIcon") }));

import PluginContributionsPanel from "@/components/plugins/PluginContributionsPanel.vue";

type PanelState = {
  batchRunning: boolean;
  batchMode: boolean;
  marketplaceViewMode: "grid" | "list";
  marketplaceRepositoryId: string;
  marketplaceListings: MarketplacePluginListing[];
  catalogResults: PluginRepositoryCatalogResult[];
  installedPlugins: InstalledPlugin[];
  repositories: PluginRepositoryCatalogResult["repository"][];
  selectedListingKeys: Set<string>;
  selectedInstalledIds: Set<string>;
  selectedPluginId: string;
  installUrl: string;
  repositoryId: string;
  repositoryName: string;
  repositoryCatalogUrl: string;
  trustedKeyId: string;
  trustedPublicKey: string;
  error: string;
  toggleListingSelection: (listing: MarketplacePluginListing) => void;
  selectAllUpdatable: () => void;
  runBatchInstallUpdate: () => Promise<void>;
  runBatchUninstall: () => Promise<void>;
  installMarketplaceListing: (listing: MarketplacePluginListing) => Promise<void>;
  installPlugin: (source: string | File) => Promise<void>;
  installPluginFromUrl: () => Promise<void>;
  uninstallSelectedPlugin: () => Promise<void>;
  rollbackSelectedPlugin: () => Promise<void>;
  saveRepository: () => Promise<void>;
  toggleRepository: (repository: PluginRepositoryCatalogResult["repository"]) => Promise<void>;
  removeRepository: (repository: PluginRepositoryCatalogResult["repository"]) => Promise<void>;
  saveTrustedKey: () => Promise<void>;
  removeTrustedKey: (keyId: string) => Promise<void>;
  toggleBatchMode: () => void;
  toggleInstalledSelection: (pluginId: string) => void;
  installedUpdateIndex: Map<string, { listing: MarketplacePluginListing; repositoryName: string }>;
  installedUpdateCount: number;
  installedUpdateProgress: { current: number; total: number } | null;
  catalogChecked: boolean;
  marketplaceUnavailable: boolean;
  catalogPartialFailure: boolean;
  pendingSourceChange: { listing: MarketplacePluginListing } | null;
  installedUnsupportedListingFor: (pluginId: string) => MarketplacePluginListing | null;
  updateInstalledPlugin: (pluginId: string) => Promise<void>;
  runUpdateAllInstalled: () => Promise<void>;
  proceedUpdateSourceChange: () => void;
  refreshMarketplace: () => Promise<void>;
};

function installed(id: string, version = "1.0.0"): InstalledPlugin {
  return {
    manifest: { manifest_version: 1, id, name: id, version, publisher: "DBX", description: "", engines: { dbx: "", host_api: "" }, permissions: [], entrypoints: {}, contributions: [], drivers: [], protocol_version: 1 },
    compatibility: { compatible: true, errors: [], warnings: [], target: "darwin-arm64" },
  };
}

function catalog(repositoryId: string, ids: string[], version = "3.0.0"): PluginRepositoryCatalogResult {
  return {
    repository: { id: repositoryId, name: repositoryId, kind: "custom", enabled: true, managed: false },
    target: "darwin-arm64",
    catalog: {
      catalogVersion: 1,
      repository: { id: repositoryId, name: repositoryId },
      plugins: ids.map((id) => ({
        id,
        name: id,
        description: "",
        publisher: "DBX",
        verified: false,
        tags: [],
        permissions: [],
        latestVersion: version,
        versions: [{ version, artifacts: [{ target: "darwin-arm64", url: "https://example.invalid/plugin.dbxp", sha256: "a".repeat(64), signingKeyId: "test.key" }] }],
      })),
    },
  };
}

function unsupportedCatalog(repositoryId: string, ids: string[], version = "3.0.0"): PluginRepositoryCatalogResult {
  const result = catalog(repositoryId, ids, version);
  // No artifact for this platform on the catalog's latest version: the listing is "unsupported"
  // rather than updatable, so the installed tab has to say so instead of reading as up to date.
  for (const plugin of result.catalog!.plugins) plugin.versions[0].artifacts = [];
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let app: App;
let host: HTMLElement;
let state: PanelState;

async function flushUi() {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

function button(key: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(`pluginPlatform.${key}:`));
  expect(match, key).toBeDefined();
  return match!;
}

const mutationApis = [mocks.installMarketplacePlugin, mocks.uninstallPlugin, mocks.rollbackPlugin, mocks.installPluginPackage, mocks.installPluginPackageFromUrl];

function mutationCount() {
  return mutationApis.reduce((count, mock) => count + mock.mock.calls.length, 0);
}

async function expectBusyControls() {
  for (const view of ["grid", "list"] as const) {
    state.marketplaceViewMode = view;
    await nextTick();
    for (const key of ["batchInstallUpdate", "batchUninstall", "marketplaceStatus.update", "uninstall", "rollback", "installPackage", "installFromUrl"]) {
      expect(button(key).disabled, `${view}: ${key}`).toBe(true);
    }
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.isTauriRuntime.mockReturnValue(false);
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({}));
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  mocks.listPlugins.mockResolvedValue([installed("a"), installed("b"), installed("c")]);
  mocks.listPluginTrustedKeys.mockResolvedValue([]);
  mocks.listPluginRepositories.mockResolvedValue([]);
  mocks.fetchPluginMarketplaceCatalogs.mockResolvedValue([catalog("first", ["a", "b", "c"])]);
  for (const mock of mutationApis) mock.mockResolvedValue({ plugin: installed("a", "3.0.0") });
  mocks.uninstallPlugin.mockResolvedValue([]);
  mocks.savePluginRepository.mockResolvedValue([]);
  mocks.removePluginRepository.mockResolvedValue([]);
  mocks.savePluginTrustedKey.mockResolvedValue([]);
  mocks.removePluginTrustedKey.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(PluginContributionsPanel, { onPluginRuntimeReplaced: mocks.refreshPluginWorkbenches });
  const instance = app.mount(host) as ComponentPublicInstance & { $: { setupState: PanelState } };
  state = instance.$.setupState;
  await flushUi();
  state.batchMode = true;
  state.selectedPluginId = "a";
  state.selectedListingKeys = new Set(["first:a"]);
  state.selectedInstalledIds = new Set(["a"]);
  state.installUrl = "https://example.invalid/plugin.dbxp";
  state.repositoryId = "custom";
  state.repositoryName = "Custom";
  state.repositoryCatalogUrl = "https://example.invalid/catalog.json";
  state.trustedKeyId = "custom";
  state.trustedPublicKey = "public-key";
  mocks.listPlugins.mockClear();
  await nextTick();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginContributionsPanel batch source validation", () => {
  it.each(["first", "second"])("does not silently resolve selected source conflicts by filtering to %s", async (repositoryId) => {
    state.catalogResults = [catalog("first", ["a"]), catalog("second", ["a"], "2.0.0")];
    state.selectAllUpdatable();
    state.marketplaceRepositoryId = repositoryId;
    await state.runBatchInstallUpdate();
    expect(mutationCount()).toBe(0);
    expect(state.selectedListingKeys.size).toBe(2);
    state.toggleListingSelection(state.marketplaceListings.find((listing) => listing.repository.id !== repositoryId)!);
    await state.runBatchInstallUpdate();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledExactlyOnceWith({ repositoryId, pluginId: "a", version: repositoryId === "first" ? "3.0.0" : "2.0.0" });
  });

  it.each(["2.0.0", "3.0.0"].flatMap((version) => ["manual", "all"].map((selection) => ({ version, selection }))))("rejects $selection duplicate sources at $version before any mutation", async ({ version, selection }) => {
    state.catalogResults = [catalog("first", ["a", "b"]), catalog("second", ["b"], version)];
    state.selectedListingKeys = new Set();
    if (selection === "all") state.selectAllUpdatable();
    else for (const listing of state.marketplaceListings) state.toggleListingSelection(listing);
    await state.runBatchInstallUpdate();
    expect(mutationCount()).toBe(0);
    expect(mocks.listPlugins).not.toHaveBeenCalled();
    expect(state.selectedListingKeys.size).toBe(3);
    expect(state.batchRunning).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('pluginPlatform.batchDuplicateSources:{"names":"b"}'), 8000);

    state.toggleListingSelection(state.marketplaceListings.find((listing) => listing.key === "first:b")!);
    await state.runBatchInstallUpdate();
    expect(mocks.installMarketplacePlugin.mock.calls.map(([request]) => request)).toEqual([
      { repositoryId: "first", pluginId: "a", version: "3.0.0" },
      { repositoryId: "second", pluginId: "b", version },
    ]);
    expect(state.selectedListingKeys.size).toBe(0);
  });
});

describe("PluginContributionsPanel update center synchronization", () => {
  it("notifies after a single marketplace update without duplicating per batch item", async () => {
    const listener = vi.fn();
    window.addEventListener(COMPONENT_UPDATES_CHANGED_EVENT, listener);
    try {
      await state.installMarketplaceListing(state.marketplaceListings[0]);
      expect(listener).toHaveBeenCalledOnce();

      listener.mockClear();
      state.selectAllUpdatable();
      await state.runBatchInstallUpdate();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(COMPONENT_UPDATES_CHANGED_EVENT, listener);
    }
  });
});

describe("PluginContributionsPanel installed plugin pin controls", () => {
  it("renders selection and pin actions as sibling native buttons", async () => {
    state.batchMode = false;
    await nextTick();

    const pinButton = [...host.querySelectorAll<HTMLElement>("[title]")].find((element) => element.title.startsWith("pluginPlatform.pinPlugin:"));
    expect(pinButton).toBeInstanceOf(HTMLButtonElement);
    expect(pinButton?.parentElement?.tagName).toBe("DIV");
    expect(pinButton?.parentElement?.querySelectorAll(":scope > button")).toHaveLength(2);
    expect(pinButton?.parentElement?.querySelector("button [role='button']")).toBeNull();
    expect(pinButton?.getAttribute("aria-pressed")).toBe("false");
    expect(pinButton?.getAttribute("aria-label")).toBe(pinButton?.title);

    state.batchMode = true;
    await nextTick();
    expect(host.querySelector("[title^='pluginPlatform.pinPlugin:'], [title^='pluginPlatform.unpinPlugin:']")).toBeNull();
    expect(host.querySelector("[data-plugin-id='a']")?.querySelectorAll(":scope > button")).toHaveLength(1);
  });

  it("keeps pin click and keyboard activation isolated from row selection", async () => {
    state.batchMode = false;
    state.selectedPluginId = "a";
    await nextTick();

    const row = host.querySelector<HTMLElement>("[data-plugin-id='b']")!;
    const [selectButton, pinButton] = [...row.querySelectorAll<HTMLButtonElement>(":scope > button")];
    expect(selectButton).toBeInstanceOf(HTMLButtonElement);
    expect(pinButton).toBeInstanceOf(HTMLButtonElement);
    expect(selectButton.tabIndex).toBe(0);
    expect(pinButton.tabIndex).toBe(0);

    pinButton.click();
    await nextTick();
    expect(state.selectedPluginId).toBe("a");
    expect(localStorage.getItem("dbx-plugin-pinned-ids")).toBe('["b"]');
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");

    pinButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(state.selectedPluginId).toBe("a");
    expect(localStorage.getItem("dbx-plugin-pinned-ids")).toBe("[]");

    pinButton.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await nextTick();
    expect(state.selectedPluginId).toBe("a");
    expect(localStorage.getItem("dbx-plugin-pinned-ids")).toBe('["b"]');

    selectButton.click();
    await nextTick();
    expect(state.selectedPluginId).toBe("b");
    expect(localStorage.getItem("dbx-plugin-pinned-ids")).toBe('["b"]');
  });
});

describe("PluginContributionsPanel installed-tab updates", () => {
  it("updates an installed plugin through the marketplace install path", async () => {
    state.batchMode = false;
    state.selectedPluginId = "a";
    await nextTick();
    expect(state.installedUpdateCount).toBe(3);

    await state.updateInstalledPlugin("a");
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledExactlyOnceWith({ repositoryId: "first", pluginId: "a", version: "3.0.0" });
    expect(mocks.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("updates all installed updatable plugins in one batch run", async () => {
    state.batchMode = false;
    mocks.installMarketplacePlugin.mockRejectedValueOnce(new Error("update denied"));
    await state.runUpdateAllInstalled();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledTimes(3);
    expect(state.error).toBe("a: update denied");
    expect(state.installedUpdateProgress).toBeNull();
    expect(state.batchRunning).toBe(false);
  });

  it("keeps source-changed plugins out of batch update and reports them", async () => {
    const moved = installed("a");
    moved.provenance = { repositoryId: "other-repo", publisher: "DBX", signingKeyId: "test.key", source: "marketplace" };
    state.installedPlugins = [moved, installed("b"), installed("c")];
    await nextTick();
    state.batchMode = false;

    await state.runUpdateAllInstalled();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("pluginPlatform.batchSourceChangeSkipped"), 8000);
  });

  it("confirms a source change before updating with allowSourceChange", async () => {
    const moved = installed("a");
    moved.provenance = { repositoryId: "other-repo", publisher: "DBX", signingKeyId: "test.key", source: "marketplace" };
    state.installedPlugins = [moved, installed("b"), installed("c")];
    await nextTick();
    state.batchMode = false;
    state.selectedPluginId = "a";

    await state.updateInstalledPlugin("a");
    expect(mutationCount()).toBe(0);
    expect(state.pendingSourceChange).not.toBeNull();

    state.proceedUpdateSourceChange();
    await flushUi();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledExactlyOnceWith({ repositoryId: "first", pluginId: "a", version: "3.0.0", allowSourceChange: true });
    expect(state.pendingSourceChange).toBeNull();
  });

  it("treats a failing enabled repository as an incomplete check, not as up to date", async () => {
    state.batchMode = false;
    state.repositories = [
      { id: "first", name: "first", kind: "custom", enabled: true, managed: false },
      { id: "second", name: "second", kind: "custom", enabled: true, managed: false },
    ];
    // "first" answers fine (a is up to date through it); "second" — b's only source — errors.
    state.catalogResults = [catalog("first", ["a"]), { ...catalog("second", ["b"]), catalog: undefined, error: "catalog offline" }];
    state.installedPlugins = [installed("a", "3.0.0"), installed("b", "1.0.0")];
    await nextTick();

    expect(state.catalogPartialFailure).toBe(true);
    // a is up to date via the first catalog, but the check is incomplete: no "all up to date".
    expect(host.textContent).not.toContain("pluginPlatform.allPluginsUpToDate");
    // b's only repository failed: it must not be labelled "not in repositories".
    expect(host.textContent).not.toContain("pluginPlatform.notInRepositories");
    // The incomplete state is surfaced instead, with the failing repository named.
    expect(host.textContent).toContain("pluginPlatform.updateCheckPartialFailure");
    expect(host.textContent).toContain("second: catalog offline");
  });

  it("flips to the up-to-date state only after a real catalog check", async () => {
    state.batchMode = false;
    state.repositories = [{ id: "first", name: "first", kind: "custom", enabled: true, managed: false }];
    await nextTick();
    expect(state.catalogChecked).toBe(true);
    expect(state.installedUpdateCount).toBe(3);

    mocks.fetchPluginMarketplaceCatalogs.mockRejectedValueOnce(new Error("offline"));
    await state.refreshMarketplace();
    expect(state.marketplaceUnavailable).toBe(true);
    expect(state.catalogChecked).toBe(false);

    await state.refreshMarketplace();
    expect(state.marketplaceUnavailable).toBe(false);

    state.installedPlugins = [installed("a", "3.0.0"), installed("b", "3.0.0"), installed("c", "3.0.0")];
    await nextTick();
    expect(state.catalogChecked).toBe(true);
    expect(state.installedUpdateCount).toBe(0);
  });

  it("surfaces installed plugins whose catalog version has no artifact for this platform", async () => {
    state.batchMode = false;
    state.catalogResults = [unsupportedCatalog("first", ["a", "b", "c"])];
    await nextTick();

    expect(state.installedUpdateCount).toBe(0);
    expect(state.installedUnsupportedListingFor("a")?.target).toBe("darwin-arm64");
    expect(host.querySelector('[data-plugin-id="a"]')?.textContent).toContain("pluginPlatform.marketplaceStatus.unsupported:");

    // The unsupported badge replaces the amber update marker, never both.
    state.catalogResults = [catalog("first", ["a", "b", "c"])];
    await nextTick();
    expect(state.installedUnsupportedListingFor("a")).toBeNull();
    expect(host.querySelector('[data-plugin-id="a"]')?.textContent).not.toContain("pluginPlatform.marketplaceStatus.unsupported:");
  });
});

describe("PluginContributionsPanel external component updates", () => {
  it("refreshes installed plugins when the update center updates plugins", async () => {
    expect(state.marketplaceListings.every((listing) => listing.status === "update")).toBe(true);
    mocks.listPlugins.mockResolvedValueOnce([installed("a", "3.0.0"), installed("b", "3.0.0"), installed("c", "3.0.0")]);

    window.dispatchEvent(new Event(COMPONENT_PLUGINS_UPDATED_EVENT));
    await flushUi();

    expect(mocks.listPlugins).toHaveBeenCalledOnce();
    expect(state.marketplaceListings.every((listing) => listing.status === "installed")).toBe(true);
  });
});

const batches = ["install", "uninstall"] as const;
type Batch = (typeof batches)[number];
const singles = ["marketplace", "uninstall", "rollback", "package", "url"] as const;
type Single = (typeof singles)[number];

function startBatch(batch: Batch) {
  return batch === "install" ? state.runBatchInstallUpdate() : state.runBatchUninstall();
}

function startSingle(single: Single) {
  switch (single) {
    case "marketplace":
      return state.installMarketplaceListing(state.marketplaceListings[0]);
    case "uninstall":
      return state.uninstallSelectedPlugin();
    case "rollback":
      return state.rollbackSelectedPlugin();
    case "package":
      return state.installPlugin("plugin.dbxp");
    case "url":
      return state.installPluginFromUrl();
  }
}

function singleApi(single: Single) {
  return { marketplace: mocks.installMarketplacePlugin, uninstall: mocks.uninstallPlugin, rollback: mocks.rollbackPlugin, package: mocks.installPluginPackage, url: mocks.installPluginPackageFromUrl }[single];
}

const replacements = ["marketplace", "rollback", "package", "url"] as const;

describe("PluginContributionsPanel workbench refresh", () => {
  it.each(replacements)("refreshes once with the returned plugin ID after Web %s succeeds", async (single) => {
    singleApi(single).mockResolvedValueOnce({ plugin: installed("replaced", "2.0.0") });
    await startSingle(single);
    expect(mocks.refreshPluginWorkbenches).toHaveBeenCalledExactlyOnceWith("replaced");
  });

  it("refreshes after uploading a Web package File", async () => {
    const file = new File(["package"], "plugin.dbxp");
    await state.installPlugin(file);
    expect(mocks.installPluginPackage).toHaveBeenCalledExactlyOnceWith(file, false);
    expect(mocks.refreshPluginWorkbenches).toHaveBeenCalledExactlyOnceWith("a");
  });

  it.each(replacements)("does not refresh after Web %s fails", async (single) => {
    singleApi(single).mockRejectedValueOnce(new Error("replacement denied"));
    await startSingle(single);
    expect(mocks.refreshPluginWorkbenches).not.toHaveBeenCalled();
  });

  it.each(replacements)("still refreshes after Web %s succeeds but the panel list reload fails", async (single) => {
    mocks.listPlugins.mockRejectedValue(new Error("list unavailable"));
    await startSingle(single);
    expect(mocks.refreshPluginWorkbenches).toHaveBeenCalledExactlyOnceWith("a");
  });

  it.each(replacements)("leaves Tauri %s refresh to the native runtime event", async (single) => {
    mocks.isTauriRuntime.mockReturnValue(true);
    await startSingle(single);
    expect(singleApi(single)).toHaveBeenCalledOnce();
    expect(mocks.refreshPluginWorkbenches).not.toHaveBeenCalled();
  });

  it("refreshes each successful Web batch replacement without waiting for the batch to finish", async () => {
    const pending = deferred<unknown>();
    state.selectAllUpdatable();
    mocks.installMarketplacePlugin.mockImplementation(async ({ pluginId }: { pluginId: string }) => {
      if (pluginId === "b") throw new Error("replacement denied");
      if (pluginId === "c") return pending.promise;
      return { plugin: installed(pluginId, "3.0.0") };
    });
    const running = state.runBatchInstallUpdate();
    try {
      await flushUi();
      expect(mocks.refreshPluginWorkbenches.mock.calls).toEqual([["a"]]);
    } finally {
      pending.resolve({ plugin: installed("c", "3.0.0") });
      await running;
    }
    expect(mocks.refreshPluginWorkbenches.mock.calls).toEqual([["a"], ["c"]]);
    expect(state.error).toContain("replacement denied");
  });

  it("leaves Tauri batch refresh to the native runtime events", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    state.selectAllUpdatable();
    await state.runBatchInstallUpdate();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledTimes(3);
    expect(mocks.refreshPluginWorkbenches).not.toHaveBeenCalled();
  });

  it("does not refresh for rejected confirmation, invalid URLs, or uninstall", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await state.rollbackSelectedPlugin();
    state.installUrl = "file:///plugin.dbxp";
    await state.installPluginFromUrl();
    expect(mutationCount()).toBe(0);
    await state.uninstallSelectedPlugin();
    expect(mocks.uninstallPlugin).toHaveBeenCalledOnce();
    expect(mocks.refreshPluginWorkbenches).not.toHaveBeenCalled();
  });
});

describe("PluginContributionsPanel mutation exclusion", () => {
  it.each(singles.flatMap((single) => [false, true].map((reject) => ({ single, reject }))))("releases single $single exclusion after rejection=$reject", async ({ single, reject }) => {
    if (reject) singleApi(single).mockRejectedValueOnce(new Error("single denied"));
    await startSingle(single);
    expect(mutationCount()).toBe(1);
    if (reject) expect(mocks.toast).toHaveBeenLastCalledWith("single denied", expect.any(Number));
    await nextTick();
    expect(button("batchInstallUpdate").disabled).toBe(false);
    await state.runBatchInstallUpdate();
    expect(mutationCount()).toBe(2);
    expect(state.batchRunning).toBe(false);
  });

  it.each(batches.flatMap((batch) => singles.map((single) => ({ batch, single }))))("blocks $single while batch $batch is pending", async ({ batch, single }) => {
    const pending = deferred<unknown>();
    (batch === "install" ? mocks.installMarketplacePlugin : mocks.uninstallPlugin).mockReturnValueOnce(pending.promise);
    const running = startBatch(batch);
    try {
      await startSingle(single);
      expect(mutationCount()).toBe(1);
      await expectBusyControls();
    } finally {
      pending.resolve(batch === "install" ? { plugin: installed("a") } : []);
      await running;
    }
  });

  it.each(singles.flatMap((single) => batches.map((batch) => ({ single, batch }))))("blocks batch $batch while single $single is pending", async ({ single, batch }) => {
    const pending = deferred<unknown>();
    singleApi(single).mockReturnValueOnce(pending.promise);
    const running = startSingle(single);
    try {
      await startBatch(batch);
      expect(mutationCount()).toBe(1);
      await expectBusyControls();
    } finally {
      pending.resolve(single === "uninstall" ? [] : { plugin: installed("a") });
      await running;
    }
  });

  it.each(batches.flatMap((first) => batches.map((second) => ({ first, second }))))("blocks batch $second while batch $first is pending", async ({ first, second }) => {
    const pending = deferred<unknown>();
    (first === "install" ? mocks.installMarketplacePlugin : mocks.uninstallPlugin).mockReturnValueOnce(pending.promise);
    const running = startBatch(first);
    try {
      await startBatch(second);
      expect(mutationCount()).toBe(1);
    } finally {
      pending.resolve(first === "install" ? { plugin: installed("a") } : []);
      await running;
    }
  });

  it.each(batches)("keeps selections stable and blocks settings mutations during batch %s", async (batch) => {
    const pending = deferred<unknown>();
    (batch === "install" ? mocks.installMarketplacePlugin : mocks.uninstallPlugin).mockReturnValueOnce(pending.promise);
    const running = startBatch(batch);
    try {
      state.toggleBatchMode();
      state.selectAllUpdatable();
      state.toggleListingSelection(state.marketplaceListings[1]);
      state.toggleInstalledSelection("b");
      expect(state.batchMode).toBe(true);
      expect([...state.selectedListingKeys]).toEqual(["first:a"]);
      expect([...state.selectedInstalledIds]).toEqual(["a"]);
      await state.saveRepository();
      await state.toggleRepository(catalog("custom", []).repository);
      await state.removeRepository(catalog("custom", []).repository);
      await state.saveTrustedKey();
      await state.removeTrustedKey("custom");
      for (const mock of [mocks.savePluginRepository, mocks.removePluginRepository, mocks.savePluginTrustedKey, mocks.removePluginTrustedKey]) expect(mock).not.toHaveBeenCalled();
      await nextTick();
      for (const key of ["batchDone", "batchSelectAllUpdatable", "addRepository"]) expect(button(key).disabled).toBe(true);
    } finally {
      pending.resolve(batch === "install" ? { plugin: installed("a") } : []);
      await running;
    }
  });

  it.each(batches)("blocks batch %s while repository settings are pending", async (batch) => {
    const pending = deferred<[]>();
    mocks.savePluginRepository.mockReturnValueOnce(pending.promise);
    const running = state.saveRepository();
    try {
      await startBatch(batch);
      expect(mutationCount()).toBe(0);
      await expectBusyControls();
    } finally {
      pending.resolve([]);
      await running;
    }
    await startBatch(batch);
    expect(mutationCount()).toBe(1);
  });
});

describe("PluginContributionsPanel completed batch outcomes", () => {
  it.each(["marketplace", "package", "url", "rollback"] as const)("shows related connection names when %s is blocked", async (entry) => {
    const blocked = new Error("Plugin update blocked by active connections: Production S3");
    const mutations = {
      marketplace: mocks.installMarketplacePlugin,
      package: mocks.installPluginPackage,
      url: mocks.installPluginPackageFromUrl,
      rollback: mocks.rollbackPlugin,
    };
    mutations[entry].mockRejectedValueOnce(blocked);
    if (entry === "marketplace") await state.installMarketplaceListing(state.marketplaceListings[0]);
    else if (entry === "package") await state.installPlugin("plugin.dbxp");
    else if (entry === "url") await state.installPluginFromUrl();
    else await state.rollbackSelectedPlugin();
    expect(mocks.toast).toHaveBeenLastCalledWith('pluginPlatform.updateBlockedByConnections:{"labels":"Production S3"}', 8000);
    expect(mocks.listPlugins).toHaveBeenCalledTimes(entry === "marketplace" ? 1 : 0);
  });

  it("shows per-plugin blockers while continuing other batch updates", async () => {
    state.selectAllUpdatable();
    mocks.installMarketplacePlugin.mockRejectedValueOnce(new Error("Plugin update blocked by active connections: Production S3"));
    await state.runBatchInstallUpdate();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledTimes(3);
    expect(state.error).toBe('a: pluginPlatform.updateBlockedByConnections:{"labels":"Production S3"}');
    await nextTick();
    expect(host.textContent).toContain("Production S3");
  });

  it.each(batches.flatMap((batch) => [0, 1, 3].map((failures) => ({ batch, failures }))))("preserves batch $batch outcomes with $failures failures when refresh rejects", async ({ batch, failures }) => {
    state.selectAllUpdatable();
    state.selectedInstalledIds = new Set(["a", "b", "c"]);
    const mutation = batch === "install" ? mocks.installMarketplacePlugin : mocks.uninstallPlugin;
    for (let index = 0; index < failures; index++) mutation.mockRejectedValueOnce(index === 0 ? "denied" : new Error("denied"));
    const refresh = deferred<InstalledPlugin[]>();
    mocks.listPlugins.mockReturnValueOnce(refresh.promise);
    const running = startBatch(batch);
    await flushUi();
    const summary = `pluginPlatform.${failures ? "batchSummaryWithFailures" : "batchSummary"}:${JSON.stringify({ success: 3 - failures, failed: failures, names: ["a", "b", "c"].slice(0, failures).join("、") })}`;
    try {
      expect(mocks.toast).toHaveBeenLastCalledWith(summary, failures ? 8000 : 4000);
      expect(state.selectedListingKeys.size).toBe(0);
      expect(state.selectedInstalledIds.size).toBe(0);
      expect(state.batchRunning).toBe(true);
      await state.installMarketplaceListing(state.marketplaceListings[0]);
      expect(mutationCount()).toBe(3);
    } finally {
      refresh.reject(new Error("refresh offline"));
      await expect(running).resolves.toBeUndefined();
    }
    expect(mutation).toHaveBeenCalledTimes(3);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenLastCalledWith(summary, failures ? 8000 : 4000);
    expect(state.error).toBe([...["a", "b", "c"].slice(0, failures).map((name) => `${name}: denied`), 'pluginPlatform.batchRefreshFailed:{"error":"refresh offline"}'].join("\n"));
    await nextTick();
    expect(host.textContent).toContain(state.error);
    expect(state.batchRunning).toBe(false);
    state.selectedListingKeys = new Set(["first:a"]);
    await state.runBatchInstallUpdate();
    expect(state.error).toBe("");
  });

  it.each(batches)("runs batch %s in order, continues after rejection and refreshes once", async (batch) => {
    state.selectAllUpdatable();
    state.selectedInstalledIds = new Set(["a", "b", "c"]);
    const mutation = batch === "install" ? mocks.installMarketplacePlugin : mocks.uninstallPlugin;
    const first = deferred<unknown>();
    mutation.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error("denied"));
    const running = startBatch(batch);
    await flushUi();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mocks.listPlugins).not.toHaveBeenCalled();
    first.resolve(batch === "install" ? { plugin: installed("a") } : []);
    await running;
    expect(mutation.mock.calls.map(([request]) => (batch === "install" ? request.pluginId : request))).toEqual(["a", "b", "c"]);
    expect(mocks.listPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenLastCalledWith('pluginPlatform.batchSummaryWithFailures:{"success":2,"failed":1,"names":"b"}', 8000);
    expect(state.error).toBe("b: denied");
    expect(state.batchRunning).toBe(false);
    expect(state.selectedListingKeys.size).toBe(0);
    expect(state.selectedInstalledIds.size).toBe(0);
  });

  it("does nothing for empty selections or cancelled uninstall", async () => {
    state.selectedListingKeys = new Set();
    await state.runBatchInstallUpdate();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await state.runBatchUninstall();
    expect(state.selectedInstalledIds.size).toBe(1);
    state.selectedInstalledIds = new Set();
    await state.runBatchUninstall();
    expect(mutationCount()).toBe(0);
    expect(mocks.listPlugins).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("ignores installed and unsupported listings in single and batch handlers", async () => {
    state.catalogResults = [catalog("first", ["a"], "1.0.0"), { ...catalog("second", ["b"]), target: "unsupported" }];
    state.selectedListingKeys = new Set();
    for (const listing of state.marketplaceListings) {
      state.toggleListingSelection(listing);
      await state.installMarketplaceListing(listing);
    }
    state.selectAllUpdatable();
    await state.runBatchInstallUpdate();
    expect(state.selectedListingKeys.size).toBe(0);
    expect(mutationCount()).toBe(0);
  });

  it("installs newly selected plugins through the rendered batch button", async () => {
    state.installedPlugins = [];
    state.selectedListingKeys = new Set();
    state.toggleListingSelection(state.marketplaceListings[0]);
    await nextTick();
    button("batchInstallUpdate").click();
    await flushUi();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledExactlyOnceWith({ repositoryId: "first", pluginId: "a", version: "3.0.0" });
    expect(mocks.toast).toHaveBeenLastCalledWith('pluginPlatform.batchSummary:{"success":1,"failed":0,"names":""}', 4000);
    expect(state.batchRunning).toBe(false);
  });
});
