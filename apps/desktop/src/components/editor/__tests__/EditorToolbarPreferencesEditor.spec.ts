// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_TOOLBAR_ORDER, type EditorToolbarActionId } from "@/lib/editor/editorToolbarPreferences";
import { SETTINGS_SEARCH_DEFINITIONS } from "@/lib/settings/settingsSearch";
import EditorToolbarPreferencesEditor from "../EditorToolbarPreferencesEditor.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let app: App;
let host: HTMLElement;
afterEach(() => {
  app?.unmount();
  host?.remove();
});

function mount() {
  const order = ref<EditorToolbarActionId[]>([...DEFAULT_EDITOR_TOOLBAR_ORDER]);
  const hidden = ref<EditorToolbarActionId[]>([]);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(EditorToolbarPreferencesEditor, {
          order: order.value,
          hiddenActions: hidden.value,
          "onUpdate:order": (value) => {
            order.value = value;
          },
          "onUpdate:hiddenActions": (value) => {
            hidden.value = value;
          },
        }),
    }),
  );
  app.mount(host);
  return { order, hidden };
}

function card(id: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-toolbar-action="${id}"]`)!;
}

describe("editor toolbar preferences", () => {
  it("is searchable within editor settings", () => {
    expect(SETTINGS_SEARCH_DEFINITIONS).toContainEqual(expect.objectContaining({ category: "editor", targetId: "editor-toolbar" }));
  });

  it("renders icons in a horizontal strip and moves actions left and right", async () => {
    const { order } = mount();
    expect(host.querySelector("[data-editor-toolbar-scroll]")?.classList.contains("overflow-x-auto")).toBe(true);
    for (const id of DEFAULT_EDITOR_TOOLBAR_ORDER) expect(card(id).querySelector("[data-toolbar-action-icon]")).not.toBeNull();
    expect(card("execute").querySelector<HTMLButtonElement>("[aria-label='settings.editorToolbarMoveLeft']")!.disabled).toBe(true);
    card("execute").querySelector<HTMLButtonElement>("[aria-label='settings.editorToolbarMoveRight']")!.click();
    await nextTick();
    expect(order.value.slice(0, 2)).toEqual(["execute-all", "execute"]);
    card("execute").querySelector<HTMLButtonElement>("[aria-label='settings.editorToolbarMoveLeft']")!.click();
    await nextTick();
    expect(order.value).toEqual(DEFAULT_EDITOR_TOOLBAR_ORDER);
  });

  it("uses a distinct foreground subtitle inside a standard settings card", () => {
    mount();
    const subtitle = host.querySelector("[data-editor-toolbar-subheading]")!;
    expect(subtitle.textContent).toBe("settings.editorToolbarVisibilityAndOrder");
    expect(subtitle.classList.contains("font-medium")).toBe(true);
    expect(subtitle.classList.contains("text-foreground")).toBe(true);
    expect(subtitle.closest(".settings-item")?.classList.contains("bg-muted/20")).toBe(true);
    expect(host.querySelector("[data-editor-toolbar-heading]")?.classList.contains("text-muted-foreground")).toBe(true);
  });

  it("matches actual toolbar glyphs and colors", () => {
    mount();
    expect(card("multi-execute").querySelector(".lucide-circle-play")).not.toBeNull();
    expect(card("semantic-diagnostics").querySelector(".lucide-spell-check-2")).not.toBeNull();
    expect(card("keyword-case").querySelector("[data-toolbar-action-icon]")?.textContent?.trim()).toBe("A");
    expect(card("format").querySelector("[data-toolbar-action-icon]")?.classList.contains("text-amber-600")).toBe(true);
    expect(card("save").querySelector("[data-toolbar-action-icon]")?.classList.contains("text-blue-600")).toBe(true);
    expect(card("word-wrap").querySelector("[data-toolbar-action-icon]")?.classList.contains("text-muted-foreground/50")).toBe(true);
  });

  it.each([
    { x: -10, expected: ["execute-all", "execute", "execute-in-new-result-tab"] },
    { x: 10, expected: ["execute-all", "execute-in-new-result-tab", "execute"] },
  ])("drops before or after a target using its horizontal midpoint ($x)", async ({ x, expected }) => {
    const { order } = mount();
    card("execute").dispatchEvent(new Event("dragstart", { bubbles: true }));
    card("execute-in-new-result-tab").dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: x }));
    await nextTick();
    expect(order.value.slice(0, 3)).toEqual(expected);
  });

  it("protects execute, toggles visibility, and restores defaults", async () => {
    const { order, hidden } = mount();
    expect(card("execute").querySelector<HTMLButtonElement>("[role=switch]")!.disabled).toBe(true);
    card("format").querySelector<HTMLButtonElement>("[role=switch]")!.click();
    await nextTick();
    expect(hidden.value).toEqual(["format"]);
    order.value.reverse();
    await nextTick();
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    expect(order.value).toEqual(DEFAULT_EDITOR_TOOLBAR_ORDER);
    expect(hidden.value).toEqual([]);
  });
});
