// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorIntentions } from "../useQueryEditorIntentions";
import QueryEditorIntentionPopup from "../QueryEditorIntentionPopup.vue";
import type { QueryEditorProps } from "../queryEditorTypes";

const metadata = vi.hoisted(() => ({ loadTableMetadata: vi.fn() }));
vi.mock("@/lib/metadata/tableMetadataCache", () => metadata);
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  metadata.loadTableMetadata.mockReset();
});

function mountIntentions(sql = "SELECT user_id FROM sys_user AS su", cursor = 14) {
  const host = document.createElement("div");
  const editorHost = document.createElement("div");
  document.body.append(host, editorHost);
  const view = new EditorView({ doc: sql, parent: editorHost });
  view.dispatch({ selection: { anchor: cursor } });
  const coords = vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 10, right: 20, top: 30, bottom: 40 });
  const props = reactive<QueryEditorProps>({ modelValue: sql, databaseType: "mysql", dialect: "mysql", connectionId: "connection", database: "db" });
  let controller!: ReturnType<typeof useQueryEditorIntentions>;
  const app = createApp({
    setup() {
      controller = useQueryEditorIntentions({ props, view: shallowRef(view), sqlBehaviorDialect: () => props.dialect, focusEditor: () => view.focus() });
      return () =>
        h(QueryEditorIntentionPopup, {
          state: controller.intentionPopup.value,
          onClose: controller.closeIntentionPopup,
          onConfirm: controller.executeIntentionAction,
          onSelect: (index) => {
            if (controller.intentionPopup.value) controller.intentionPopup.value.selectedIndex = index;
          },
        });
    },
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    view.destroy();
    host.remove();
    editorHost.remove();
  };
  cleanups.push(unmount);
  return { controller, view, props, coords, unmount };
}

function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

describe("QueryEditor intention popup extraction", () => {
  it("renders the real intention at the cursor and confirms it by keyboard", async () => {
    const { controller, view } = mountIntentions();
    expect(controller.handleSqlIntentionActions(view)).toBe(true);
    await nextTick();
    const popup = document.querySelector<HTMLElement>(".intention-popup")!;
    expect(popup.style.left).toBe("28px");
    expect(popup.style.top).toBe("44px");
    expect(popup.textContent).toContain("intentionQualifyIdentifier");
    expect(press("Enter").defaultPrevented).toBe(true);
    await nextTick();
    expect(view.state.doc.toString()).toBe("SELECT `su`.`user_id` FROM sys_user AS su");
    expect(document.querySelector(".intention-popup")).toBeNull();
    expect(view.hasFocus).toBe(true);
    expect(press("ArrowDown").defaultPrevented).toBe(false);
  });

  it("keeps keyboard selection bounded and forwards mouse hover and click", async () => {
    const { controller, view } = mountIntentions();
    controller.handleSqlIntentionActions(view);
    const popup = controller.intentionPopup.value!;
    popup.actions.push({ ...popup.actions[0], label: "Alternative", replacement: "`other`.`user_id`" });
    press("ArrowDown");
    press("ArrowDown");
    expect(popup.selectedIndex).toBe(1);
    press("ArrowUp");
    press("ArrowUp");
    expect(popup.selectedIndex).toBe(0);
    await nextTick();
    const alternative = document.querySelectorAll<HTMLElement>(".intention-popup-item")[1];
    expect(alternative.textContent).toContain("Alternative");
    alternative.dispatchEvent(new MouseEvent("mouseenter"));
    expect(popup.selectedIndex).toBe(1);
    alternative.click();
    expect(view.state.doc.toString()).toBe("SELECT `other`.`user_id` FROM sys_user AS su");
  });

  it.each(["Escape", "outside"])("cancels with %s and releases its keyboard handler", async (method) => {
    const { controller, view } = mountIntentions();
    const sql = view.state.doc.toString();
    controller.handleSqlIntentionActions(view);
    await nextTick();
    if (method === "Escape") expect(press("Escape").defaultPrevented).toBe(true);
    else document.querySelector<HTMLElement>(".intention-popup-overlay")!.click();
    expect(controller.intentionPopup.value).toBeNull();
    expect(view.state.doc.toString()).toBe(sql);
    expect(press("Enter").defaultPrevented).toBe(false);
  });

  it("does not open for read-only editors, missing cursor coordinates or non-actionable SQL", () => {
    const { controller, view, props, coords } = mountIntentions();
    props.readOnly = true;
    expect(controller.handleSqlIntentionActions(view)).toBe(false);
    props.readOnly = false;
    coords.mockReturnValue(null);
    expect(controller.handleSqlIntentionActions(view)).toBe(false);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 1" }, selection: { anchor: 0 } });
    expect(controller.handleSqlIntentionActions(view)).toBe(false);
    expect(controller.intentionPopup.value).toBeNull();
  });

  it("applies batch replacements from right to left without offset drift", () => {
    const { controller, view } = mountIntentions("SELECT id, name FROM users", 8);
    controller.handleSqlIntentionActions(view);
    controller.executeIntentionAction({
      kind: "batch_qualify_identifiers",
      span: { start: 7, end: 15 },
      replacement: "",
      replacements: [
        { span: { start: 7, end: 9 }, replacement: "users.id" },
        { span: { start: 11, end: 15 }, replacement: "users.name" },
      ],
    });
    expect(view.state.doc.toString()).toBe("SELECT users.id, users.name FROM users");
  });

  it.each([false, true])("keeps asynchronous wildcard expansion guarded against a changed document (%s)", async (changeDocument) => {
    let resolveMetadata!: (value: unknown) => void;
    metadata.loadTableMetadata.mockReturnValue(
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
    );
    const { controller, view } = mountIntentions("SELECT * FROM users", 8);
    expect(controller.handleSqlIntentionActions(view)).toBe(true);
    const action = controller.intentionPopup.value!.actions.find((candidate) => candidate.kind === "expand_wildcard")!;
    controller.executeIntentionAction(action);
    await vi.waitFor(() => expect(metadata.loadTableMetadata).toHaveBeenCalledTimes(1));
    if (changeDocument) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 2" } });
    resolveMetadata({ metadata: { columns: [{ name: "id" }, { name: "name" }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => {
      if (changeDocument) expect(view.state.doc.toString()).toBe("SELECT 2");
      else expect(view.state.doc.toString()).toMatch(/SELECT .*id.*name.* FROM users/);
    });
    await nextTick();
    if (changeDocument) expect(view.state.doc.toString()).toBe("SELECT 2");
  });

  it("leaves the document unchanged when metadata loading fails", async () => {
    metadata.loadTableMetadata.mockRejectedValue(new Error("metadata unavailable"));
    const { controller, view } = mountIntentions("SELECT * FROM users", 8);
    controller.handleSqlIntentionActions(view);
    controller.executeIntentionAction(controller.intentionPopup.value!.actions[0]);
    await vi.waitFor(() => expect(metadata.loadTableMetadata).toHaveBeenCalledTimes(1));
    await nextTick();
    expect(view.state.doc.toString()).toBe("SELECT * FROM users");
  });

  it("removes the teleported popup and keyboard handler on unmount", async () => {
    const { controller, view, unmount } = mountIntentions();
    const remove = vi.spyOn(document, "removeEventListener");
    controller.handleSqlIntentionActions(view);
    await nextTick();
    unmount();
    expect(remove.mock.calls.some(([event]) => event === "keydown")).toBe(true);
    expect(document.querySelector(".intention-popup-overlay")).toBeNull();
    expect(press("Enter").defaultPrevented).toBe(false);
  });
});
