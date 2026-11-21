// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import type { MqSystemKind } from "@/types/mq";
import { useMqTopicColumnResize } from "../useMqTopicColumnResize";

let app: App | undefined;
let root: HTMLDivElement;
const kind = ref<MqSystemKind>("rabbitmq");
const allVhosts = ref(false);
let resize: ReturnType<typeof useMqTopicColumnResize>;

function mount() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    setup() {
      resize = useMqTopicColumnResize(kind, allVhosts);
      return () =>
        h(
          "div",
          resize.columns.value.map((column) => h("div", { "data-column": column.key }, [h("div", { onMousedown: (event: MouseEvent) => resize.onResizeStart(column, event) })])),
        );
    },
  });
  app.mount(root);
}

function startDrag(key: string, width: number) {
  const cell = root.querySelector<HTMLElement>(`[data-column="${key}"]`)!;
  vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
  cell.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, button: 0 }));
}

function drag(key: string, width: number, delta: number) {
  startDrag(key, width);
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + delta }));
  document.dispatchEvent(new MouseEvent("mouseup", { clientX: 100 + delta }));
}

beforeEach(() => {
  localStorage.clear();
  kind.value = "rabbitmq";
  allVhosts.value = false;
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.restoreAllMocks();
});

describe("MQ topic column widths", () => {
  it.each<MqSystemKind>(["rabbitmq", "kafka", "rocketmq", "pulsar"])("persists a dragged name width across remount for %s", async (system) => {
    kind.value = system;
    mount();
    drag("name", 300, 250);
    expect(resize.gridTemplateColumns.value.split(" ")[0]).toBe("550px");
    expect(JSON.parse(localStorage.getItem(`dbx-mq-topic-column-widths:${system}`)!)).toEqual({ name: 550 });
    app!.unmount();
    root.remove();
    mount();
    await nextTick();
    expect(resize.gridTemplateColumns.value.startsWith("550px ")).toBe(true);
    expect(resize.minWidth.value).toBeGreaterThan(550);
  });

  it("keeps column identities across all-vhost toggles and isolates source types", async () => {
    mount();
    drag("name", 300, 250);
    drag("type", 110, 40);
    allVhosts.value = true;
    await nextTick();
    expect(resize.gridTemplateColumns.value).toBe("550px minmax(100px, 0.8fr) 150px 170px 90px 70px 190px minmax(150px, 1fr)");
    drag("namespace", 100, 100);
    allVhosts.value = false;
    await nextTick();
    expect(resize.gridTemplateColumns.value.startsWith("550px 150px")).toBe(true);
    kind.value = "kafka";
    await nextTick();
    expect(resize.gridTemplateColumns.value).toBe("minmax(180px, 1.6fr) 120px 140px minmax(150px, 1fr)");
    kind.value = "rabbitmq";
    allVhosts.value = true;
    await nextTick();
    expect(resize.gridTemplateColumns.value.startsWith("550px 200px 150px")).toBe(true);
  });

  it("clamps widths and tolerates corrupt or invalid stored values", () => {
    localStorage.setItem("dbx-mq-topic-column-widths:rabbitmq", '{"name":1,"type":"wide","features":-5}');
    mount();
    expect(resize.gridTemplateColumns.value.startsWith("180px 110px 170px")).toBe(true);
    drag("name", 300, -900);
    expect(resize.gridTemplateColumns.value.startsWith("180px ")).toBe(true);
    app!.unmount();
    root.remove();
    localStorage.setItem("dbx-mq-topic-column-widths:rabbitmq", "invalid json");
    mount();
    expect(resize.gridTemplateColumns.value.startsWith("minmax(180px, 1.6fr)")).toBe(true);
  });

  it("cleans up an active drag on unmount without saving later mouse events", () => {
    mount();
    const previousCursor = document.body.style.cursor;
    startDrag("name", 300);
    expect(document.body.style.cursor).toBe("col-resize");
    app!.unmount();
    expect(document.body.style.cursor).toBe(previousCursor);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 700 }));
    expect(localStorage.getItem("dbx-mq-topic-column-widths:rabbitmq")).toBeNull();
  });

  it("cleans up drag listeners when the window loses focus", () => {
    mount();
    startDrag("name", 300);
    window.dispatchEvent(new Event("blur"));
    expect(resize.resizingColumn.value).toBeNull();
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 700 }));
    expect(localStorage.getItem("dbx-mq-topic-column-widths:rabbitmq")).toBeNull();
  });
});
