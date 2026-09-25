/** @vitest-environment happy-dom */

import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TAB_PAGE_UI_STATE_BYTES, provideTabUiState, sanitizeTabPageUiState, sanitizeTabUiState, TAB_UI_STATE_TRACK_DEBOUNCE_MS, useTabUiState } from "@/lib/tabs/tabUiState";

const mounted: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mounted.splice(0)) {
    unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("tabUiState", () => {
  it("restores a namespace and flushes its last value before unmount", async () => {
    vi.useFakeTimers();
    const updates: unknown[] = [];
    const trackedValue = ref(0);
    let initialValue = 0;
    let captureCount = 0;

    const Child = defineComponent({
      setup() {
        const state = useTabUiState<{ value?: number }>({}, "Panel");
        initialValue = state.initialState.value ?? 0;
        trackedValue.value = initialValue;
        state.track(() => ({ value: trackedValue.value }));
        return () => h("span", String(trackedValue.value));
      },
    });
    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => {
          captureCount += 1;
          return {
            snapshot: { Panel: { value: 7 } },
            update: (patch) => updates.push(patch),
          };
        });
        return () => h(Child);
      },
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(Parent);
    app.mount(host);
    mounted.push({ unmount: () => app.unmount(), host });

    expect(initialValue).toBe(7);
    expect(captureCount).toBe(1);

    trackedValue.value = 8;
    await nextTick();
    expect(updates).toHaveLength(0);
    vi.advanceTimersByTime(TAB_UI_STATE_TRACK_DEBOUNCE_MS);
    await nextTick();
    expect(updates.at(-1)).toEqual({ Panel: { value: 8 } });

    trackedValue.value = 9;
    app.unmount();
    mounted.length = 0;
    host.remove();
    expect(updates.at(-1)).toEqual({ Panel: { value: 9 } });
  });

  it("rejects cyclic, oversized, and non-plain snapshots", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(sanitizeTabPageUiState(cyclic)).toBeUndefined();
    expect(sanitizeTabPageUiState({ value: "x".repeat(MAX_TAB_PAGE_UI_STATE_BYTES + 1) })).toBeUndefined();
    expect(sanitizeTabPageUiState({ value: new Date() })).toBeUndefined();
  });

  it("keeps only supported top-level state and JSON-compatible page values", () => {
    const state = sanitizeTabUiState({
      activeOutputView: "invalid",
      resultPaneOpen: false,
      ignored: true,
      page: {
        query: {
          Panel: {
            count: 3,
            invalidNumber: Number.POSITIVE_INFINITY,
            callback: () => undefined,
          },
        },
      },
    });

    expect(state).toEqual({
      resultPaneOpen: false,
      page: { query: { Panel: { count: 3 } } },
    });
  });
});
