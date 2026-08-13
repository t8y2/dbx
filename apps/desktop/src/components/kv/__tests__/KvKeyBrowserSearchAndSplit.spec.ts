import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser search and split layout", () => {
  it("uses the requested prefix for a server-side, paginated search", () => {
    expect(browserSource).toContain("props.api.listPrefix(connectionId, searchQuery, pageSize, reset ? null : continuation.value");
    expect(browserSource).not.toContain("async function searchAllKeys");
    expect(browserSource).not.toContain("filterKvKeysBySearch(result.keys, query)");
  });

  it("focuses a matching Consul directory instead of nesting it beneath itself", () => {
    expect(browserSource).toContain('const focusedDirectory = props.lazyPathStyle === "relative" && rootPath && !rootPath.endsWith("/")');
    expect(browserSource).toContain("key.key === `${rootPath}/`");
    expect(browserSource).toContain("const childResult = await props.api.listPrefix(context.connectionId, focusedDirectory.key, pageSize, null, { recursive: false });");
    expect(browserSource).toContain("if (rootSummary?.hasValue !== true)");
    expect(browserSource).toContain("hasValue: true");
  });

  it("offers debounced, server-backed prefix completion for lazy Consul trees", () => {
    expect(browserSource).toContain("const remoteKeySuggestions = ref<KvKeySummary[]>([]);");
    expect(browserSource).toContain("const keySuggestionDebounceMs = 300;");
    expect(browserSource).toContain("function scheduleRemoteKeySuggestions(value: string)");
    expect(browserSource).toContain("listPrefix(connectionId, query, 8, null, { recursive: false })");
    expect(browserSource).toContain("const candidates = props.lazyHierarchy ? [...lazyTreeState.nodeByKey.values(), ...remoteKeySuggestions.value] : keys.value;");
    expect(browserSource).toContain('autocomplete="off"');
    expect(browserSource).toContain('<Popover :open="showKeySuggestions">');
    expect(browserSource).toContain('<PopoverContent v-if="showKeySuggestions" id="kv-key-prefix-suggestions"');
    expect(browserSource).toContain('if (props.lazyHierarchy && suggestion.key.endsWith("/"))');
    expect(browserSource).toContain("scheduleRemoteKeySuggestions(suggestion.key);");
    expect(browserSource).toContain('event.key !== "Enter" && event.key !== "Tab"');
  });

  it("drops stale lazy tree responses after a connection or root generation changes", () => {
    expect(browserSource).toContain("generation: ++keyLoadGeneration");
    expect(browserSource).toContain("function lazyLoadContextValid(context: LazyLoadContext)");
    expect(browserSource).toContain("context.connectionId === props.connectionId");
    expect(browserSource).toContain("lazyTreeState.nodeByKey.get(parentKey) !== node");
    expect(browserSource).toContain("keyLoadGeneration++;");
  });

  it("highlights the matching search query only for the selected search result", () => {
    expect(browserSource).toContain("interface KvSearchHighlight");
    expect(browserSource).toMatch(/const activeSearchHighlight = computed\(\(\) => \(?props\.searchHighlight\?\.key === selectedKey\.value/);
    expect(browserSource).toContain("function highlightText(value: string, enabled: boolean)");
    expect(browserSource).toContain("selectedValueHighlightSegments");
  });

  it("does not select Key text while opening its context menu", () => {
    expect(browserSource).toContain("select-none items-center");
    expect(browserSource).toContain("@mousedown.right.prevent");
  });

  it("uses a persisted draggable split between the Key tree and details", () => {
    expect(browserSource).toContain('<Splitpanes class="kv-browser-splitpanes min-h-0 flex-1" @resized="handleKvBrowserSplitResized">');
    expect(browserSource).toContain('<Pane :size="kvBrowserSplitSize" min-size="20" max-size="70">');
    expect(browserSource).toContain('<Pane :size="100 - kvBrowserSplitSize" min-size="30">');
    expect(browserSource).toContain("safeLocalStorageSet(kvBrowserSplitSizeStorageKey, String(size))");
    expect(browserSource).toContain("cursor: col-resize");
  });
});
