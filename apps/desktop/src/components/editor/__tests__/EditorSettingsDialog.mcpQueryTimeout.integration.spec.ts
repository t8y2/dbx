// @vitest-environment happy-dom
// Real-DOM integration for the MCP query-timeout input (#8616). The settings
// dialog reads the fresh value from the native event target in capture phase,
// before Input's passive v-model proxy updates the parent ref. This test mounts the real
// Input component with exactly that wiring and drives it with real DOM events
// to prove the typing -> debounce -> saveMcpPolicy chain persists the fresh
// value (a two-way v-model would make the passive proxy emit asynchronously,
// so the handler would read a stale ref during the same native event).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import Input from "@/components/ui/input/Input.vue";
import { createMcpQueryTimeoutHarness, type McpQueryTimeoutHarness } from "./mcpQueryTimeoutHarness";
import dialogSource from "../EditorSettingsDialog.vue?raw";

describe("EditorSettingsDialog MCP query timeout real-DOM integration", () => {
  const mountedApps: App[] = [];

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  async function mountInput(wiring: { modelValue: { value: string }; onInput: (event: Event) => void }): Promise<HTMLInputElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(Input, {
            modelValue: wiring.modelValue.value,
            "onUpdate:modelValue": (v: string) => {
              wiring.modelValue.value = v;
            },
            onInputCapture: wiring.onInput,
          }),
      }),
    );
    mountedApps.push(app);
    app.mount(container);
    await nextTick();
    const el = container.querySelector("input");
    if (!el) throw new Error("input not rendered");
    return el as HTMLInputElement;
  }

  function harnessFor(saveMcpPolicy: ReturnType<typeof vi.fn>): { harness: McpQueryTimeoutHarness; inputRef: { value: string } } {
    const inputRef = { value: "" };
    const harness = createMcpQueryTimeoutHarness({
      source: dialogSource,
      input: inputRef,
      policyQueryTimeoutSecs: null,
      saveMcpPolicy,
    });
    return { harness, inputRef };
  }

  it("typing into the real Input persists the fresh value after debounce", async () => {
    vi.useFakeTimers();
    const saveMcpPolicy = vi.fn();
    const { harness, inputRef } = harnessFor(saveMcpPolicy);

    const el = await mountInput({
      modelValue: inputRef,
      onInput: harness.onMcpQueryTimeoutInput,
    });

    // Simulate real typing: set the DOM value and dispatch a native input event.
    el.value = "300";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // The debounce has not elapsed yet: no save.
    expect(saveMcpPolicy).not.toHaveBeenCalled();

    // Elapse the debounce window and assert the FRESH value was saved.
    vi.advanceTimersByTime(300);
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expect(saveMcpPolicy.mock.calls.at(-1)?.[0]).toEqual({ queryTimeoutSecs: 300 });
  });

  it("typing then flushing on close persists the fresh value immediately", async () => {
    vi.useFakeTimers();
    const saveMcpPolicy = vi.fn();
    const { harness, inputRef } = harnessFor(saveMcpPolicy);

    const el = await mountInput({
      modelValue: inputRef,
      onInput: harness.onMcpQueryTimeoutInput,
    });

    el.value = "120";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Close path: flush before the debounce elapses.
    harness.flushMcpQueryTimeoutSave();
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expect(saveMcpPolicy.mock.calls.at(-1)?.[0]).toEqual({ queryTimeoutSecs: 120 });
  });

  it("rapid typing in the real DOM coalesces into one save of the last value", async () => {
    vi.useFakeTimers();
    const saveMcpPolicy = vi.fn();
    const { harness, inputRef } = harnessFor(saveMcpPolicy);

    const el = await mountInput({
      modelValue: inputRef,
      onInput: harness.onMcpQueryTimeoutInput,
    });

    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(100);
    el.value = "12";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(100);
    el.value = "123";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(300);

    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expect(saveMcpPolicy.mock.calls.at(-1)?.[0]).toEqual({ queryTimeoutSecs: 123 });
  });
});
