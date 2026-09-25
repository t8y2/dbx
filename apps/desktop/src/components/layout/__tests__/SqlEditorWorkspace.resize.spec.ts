// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginPanelResize, deferUntilPanelResizeEnd, endPanelResize, isPanelResizing } from "@/lib/app/panelResizeState";
import { useQueryStore } from "@/stores/queryStore";
import type { QueryTab } from "@/types/database";
import SqlEditorWorkspace from "../SqlEditorWorkspace.vue";

vi.mock("@/components/layout/EditorGroup.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/layout/QueryResultSurface.vue", () => ({ default: { template: "<div />" } }));

describe("workspace real Splitpanes drag lifecycle", () => {
  let frames: FrameRequestCallback[];
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    localStorage.removeItem("dbx-shared-results-pane-size");
  });

  afterEach(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();
    cleanup?.();
    cleanup = undefined;
    endPanelResize();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  async function flushFrames() {
    const pending = frames.splice(0);
    for (const callback of pending) callback(0);
    await nextTick();
  }

  async function mountWorkspace(orientation: "horizontal" | "vertical" = "vertical") {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useQueryStore();
    const tabs: QueryTab[] = ["first", "second"].map((id) => ({
      id,
      title: id,
      connectionId: "conn",
      database: "db",
      sql: "SELECT 1",
      mode: "query",
      isExecuting: false,
      result: { columns: ["id"], rows: [], affected_rows: 0, execution_time_ms: 1 },
    }));
    store.tabs = tabs;
    store.activeTabId = tabs[0]!.id;
    store.groups = tabs.map((tab) => ({ id: tab.id, tabIds: [tab.id], activeTabId: tab.id }));
    store.focusedGroupId = tabs[0]!.id;
    store.sizes = [50, 50];
    store.orientation = orientation;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(SqlEditorWorkspace, {
      activeTab: tabs[0],
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
    });
    app.use(pinia);
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    cleanup = () => app.unmount();
    await nextTick();
    for (const container of host.querySelectorAll(".splitpanes")) {
      Object.defineProperty(container, "clientWidth", { value: 1000 });
      Object.defineProperty(container, "clientHeight", { value: 1000 });
    }
    await flushFrames();
    return { host, store, app };
  }

  function start(host: HTMLElement, shared = false) {
    const selector = shared ? ".sql-editor-workspace-split" : ".sql-editor-groups";
    const splitter = host.querySelector(`${selector} > .splitpanes__splitter`)!;
    vi.spyOn(splitter, "getBoundingClientRect").mockReturnValue({ left: 500, top: 500 } as DOMRect);
    splitter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 500 }));
  }

  function move(position: number) {
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: position, clientY: position }));
  }

  it.each(["horizontal", "vertical", "shared"] as const)("ignores queued resize after release for %s panes and preserves final sizes", async (layout) => {
    const { host, store } = await mountWorkspace(layout === "horizontal" ? "horizontal" : "vertical");
    start(host, layout === "shared");
    move(600);
    await flushFrames();
    expect(isPanelResizing.value).toBe(true);
    const resync = vi.fn();
    expect(deferUntilPanelResizeEnd(resync)).toBe(true);
    move(650);
    expect(frames.length).toBeGreaterThan(0);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(isPanelResizing.value).toBe(false);
    expect(resync).toHaveBeenCalledTimes(1);
    const sizes = [...store.sizes];
    const resultSize = localStorage.getItem("dbx-shared-results-pane-size");
    if (layout === "shared") expect(Number(resultSize)).toBeCloseTo(40);
    else expect(sizes).toEqual([60, 40]);
    await flushFrames();
    expect(isPanelResizing.value).toBe(false);
    expect(document.body.classList.contains("dbx-is-resizing")).toBe(false);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(store.sizes).toEqual(sizes);
    expect(localStorage.getItem("dbx-shared-results-pane-size")).toBe(resultSize);
  });

  it("ignores the first queued frame when released before any frame runs", async () => {
    const { host } = await mountWorkspace();
    start(host);
    move(600);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushFrames();
    expect(isPanelResizing.value).toBe(false);
    expect(document.body.classList.contains("dbx-is-resizing")).toBe(false);
  });

  it.each(["pointerup", "pointercancel", "blur", "unmount"])("cleans up on %s", async (eventName) => {
    const { host } = await mountWorkspace();
    start(host);
    move(600);
    await flushFrames();
    const resync = vi.fn();
    deferUntilPanelResizeEnd(resync);
    if (eventName !== "unmount") move(650);
    if (eventName === "unmount") {
      cleanup?.();
      cleanup = undefined;
    } else if (eventName === "blur") window.dispatchEvent(new Event(eventName));
    else document.dispatchEvent(new Event(eventName));
    expect(isPanelResizing.value).toBe(false);
    await flushFrames();
    expect(isPanelResizing.value).toBe(false);
    expect(document.body.classList.contains("dbx-is-resizing")).toBe(false);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it.each(["touchend", "touchcancel"])("tracks real touch dragging and cleans up on %s", async (eventName) => {
    vi.stubGlobal("ontouchstart", null);
    const { host } = await mountWorkspace();
    const splitter = host.querySelector(".sql-editor-groups > .splitpanes__splitter")!;
    const touchStart = new Event("touchstart", { bubbles: true });
    Object.defineProperty(touchStart, "touches", { value: [{ clientX: 0, clientY: 0 }] });
    splitter.dispatchEvent(touchStart);
    const touchMove = new Event("touchmove", { bubbles: true });
    Object.defineProperty(touchMove, "touches", { value: [{ clientX: 600, clientY: 600 }] });
    document.dispatchEvent(touchMove);
    await flushFrames();
    expect(isPanelResizing.value).toBe(true);
    document.dispatchEvent(touchMove);
    document.dispatchEvent(new Event(eventName, { bubbles: true }));
    await flushFrames();
    expect(isPanelResizing.value).toBe(false);
  });

  it("keeps tracking across frames and pauses until the real release", async () => {
    const { host, store } = await mountWorkspace();
    start(host);
    move(600);
    await flushFrames();
    const resync = vi.fn();
    deferUntilPanelResizeEnd(resync);
    vi.advanceTimersByTime(1600);
    expect(isPanelResizing.value).toBe(true);
    move(700);
    await flushFrames();
    expect(isPanelResizing.value).toBe(true);
    expect(resync).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(store.sizes).toEqual([70, 30]);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("does not let a previous drag's queued frame end the next drag", async () => {
    const { host } = await mountWorkspace();
    start(host);
    move(600);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.advanceTimersByTime(100);
    start(host);
    expect(isPanelResizing.value).toBe(true);
    await flushFrames();
    expect(isPanelResizing.value).toBe(true);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(isPanelResizing.value).toBe(false);
  });

  it("ignores content clicks and leaves another panel's resize state alone", async () => {
    const { host, store } = await mountWorkspace();
    host.querySelector(".splitpanes__pane")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isPanelResizing.value).toBe(false);
    beginPanelResize();
    store.sizes = [55, 45];
    await nextTick();
    await flushFrames();
    expect(isPanelResizing.value).toBe(true);
    cleanup?.();
    cleanup = undefined;
    expect(isPanelResizing.value).toBe(true);
  });
});
