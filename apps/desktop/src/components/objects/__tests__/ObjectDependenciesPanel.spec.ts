// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectDependenciesPanel from "../ObjectDependenciesPanel.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ObjectDetailsSection } from "@/lib/database/objectDependencyDetails";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), cancelQuery: vi.fn(async () => true), checkConnectionHealth: vi.fn(async () => undefined) }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
const target = { connectionId: "source-connection", database: "ORCL", schema: "Original.Owner", name: "P", objectType: "PROCEDURE" as const };
const mounted: Array<{ app: App; host: HTMLElement; pinia: Pinia }> = [];
function mountPanel(initial: ObjectDetailsSection = "source") {
  const pinia = createPinia();
  const connections = useConnectionStore(pinia);
  connections.connectedIds.add(target.connectionId);
  const section = ref(initial),
    open = ref(true);
  const onOpenObject = vi.fn(),
    onViewSql = vi.fn();
  const app = createApp({
    render: () =>
      h(
        ObjectDependenciesPanel,
        {
          target,
          section: section.value,
          open: open.value,
          "onUpdate:section": (value: ObjectDetailsSection) => {
            section.value = value;
          },
          onOpenObject,
          onViewSql,
        },
        { default: () => h("textarea", { "data-source-draft": "", defaultValue: "draft" }) },
      ),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  mounted.push({ app, host, pinia });
  return { host, section, open, onOpenObject, onViewSql };
}
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
}
beforeEach(() => {
  vi.clearAllMocks();
  backend.executeQuery.mockResolvedValue({
    columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
    rows: [
      ["DEPENDS_ON", "Original.Owner", "P", "PROCEDURE", "Other.Owner", "Mixed.Table", "TABLE", "HARD", null],
      ["REFERENCED_BY", "Caller", "Call.P", "FUNCTION", "Original.Owner", "P", "PROCEDURE", "HARD", null],
      ["DEPENDS_ON", "Original.Owner", "P", "PROCEDURE", "Remote", "T", "TABLE", "HARD", "REMOTE_DB"],
      ["DEPENDS_ON", "Original.Owner", "P", "PROCEDURE", "Other.Owner", "Kind", "TYPE", "HARD", null],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
  });
});
afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.app.unmount();
    item.host.remove();
    disposePinia(item.pinia);
  }
});

describe("object details shared sections", () => {
  it("preserves the source element, draft and selection while switching and refreshing dependencies", async () => {
    const { host, section } = mountPanel();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "changed source draft";
    editor.setSelectionRange(2, 8);
    button(host, "objectDependencies.dependencies").click();
    await vi.waitFor(() => expect(host.textContent).toContain("Mixed.Table"));
    expect(section.value).toBe("dependencies");
    button(host, "common.refresh").click();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(2));
    button(host, "objects.source").click();
    await nextTick();
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("changed source draft");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 8]);
  });

  it("renders directions separately and forwards a captured origin with exact object identity", async () => {
    const { host, section, onOpenObject, onViewSql } = mountPanel("dependencies");
    await vi.waitFor(() => expect(host.textContent).toContain("Mixed.Table"));
    button(host, "Mixed.Table").click();
    expect(onOpenObject).toHaveBeenCalledWith(target, { name: "Mixed.Table", schema: "Other.Owner", type: "table", nameQuoted: true, schemaQuoted: true });
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Kind")).toBe(false);
    expect(host.textContent).toContain("objectDependencies.remoteObject");
    expect(host.textContent).toContain("objectDependencies.unsupportedObject");
    button(host, "objectDependencies.viewSql").click();
    expect(onViewSql).toHaveBeenCalledWith(target, expect.stringContaining("ALL_DEPENDENCIES"));
    expect(backend.executeQuery).toHaveBeenCalledTimes(1);
    const tab = host.querySelector<HTMLButtonElement>('[data-object-section="dependencies"]')!;
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(section.value).toBe("dependents");
    expect(document.activeElement?.getAttribute("data-object-section")).toBe("dependents");
    const visiblePanel = host.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby$="dependents-tab"]')!;
    expect(visiblePanel.textContent).toContain("Call.P");
    expect(visiblePanel.textContent).not.toContain("Mixed.Table");
    expect(host.querySelector("textarea")).toBeNull();
  });
});
