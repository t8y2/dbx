// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SqlFileSearchMode } from "@/lib/sql/sqlFileTreeFilter";
import { changeSearchMode } from "./sqlSearchTestUtils";
vi.mock("@/components/ui/select", () => import("./sqlSearchTestUtils"));
import SqlPanelSearch from "../SqlPanelSearch.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
async function mountSearch(initialMode: SqlFileSearchMode = "content") {
  const mode = ref(initialMode);
  const onQuery = vi.fn();
  const onPending = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () =>
      h(SqlPanelSearch, {
        panel: "file",
        mode: mode.value,
        "onUpdate:mode": (value: SqlFileSearchMode) => {
          mode.value = value;
        },
        onQuery,
        onPending,
      }),
  });
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  const input = host.querySelector<HTMLInputElement>("input")!;
  async function type(value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await nextTick();
  }
  return { host, input, type, onQuery, onPending };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("SqlPanelSearch", () => {
  it("keeps content keystrokes local until 500 ms after the final input", async () => {
    const { type, input, onQuery, onPending } = await mountSearch();
    await type("sel");
    await vi.advanceTimersByTimeAsync(300);
    await type("select");
    expect(input.value).toBe("select");
    await vi.advanceTimersByTimeAsync(499);
    expect(onQuery).not.toHaveBeenCalled();
    expect(onPending.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(onQuery.mock.calls).toEqual([["select"]]);
    expect(onPending.mock.calls).toEqual([[true], [false]]);
    await type("select from");
    // The parent continues showing its last committed query while typing.
    expect(onQuery).toHaveBeenCalledTimes(1);
  });

  it("commits immediately on Enter and does not fire again at the old deadline", async () => {
    const { type, input, onQuery } = await mountSearch();
    await type("select");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onQuery.mock.calls).toEqual([["select"]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuery).toHaveBeenCalledTimes(1);
  });

  it("pauses for IME composition, including the Enter used to confirm a candidate", async () => {
    const { type, input, onQuery } = await mountSearch();
    await type("sel");
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(600);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    expect(onQuery).not.toHaveBeenCalled();
    input.value = "请求方式";
    input.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);
    expect(onQuery.mock.calls).toEqual([["请求方式"]]);
  });

  it("keeps filename filtering immediate and cancels pending content work on switching back", async () => {
    const { host, type, onQuery, onPending } = await mountSearch("name");
    await type("query");
    expect(onQuery.mock.calls).toEqual([["query"]]);
    await changeSearchMode(host, "content");
    expect(onPending.mock.calls).toEqual([[true]]);
    await type("queries");
    await changeSearchMode(host, "name");
    expect(onQuery.mock.calls).toEqual([["query"], ["queries"]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(onPending.mock.calls).toEqual([[true], [false]]);
  });

  it("clears immediately and never submits a delayed query after unmount", async () => {
    const { host, type, onQuery } = await mountSearch();
    await type("select");
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(onQuery.mock.calls.every(([query]) => query === "")).toBe(true);
    await type("other");
    const { app } = mounted.pop()!;
    app.unmount();
    host.remove();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuery.mock.calls.every(([query]) => query === "")).toBe(true);
  });
});
