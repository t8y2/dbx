// @vitest-environment happy-dom
// Real-DOM integration for the MCP query-timeout input. The settings dialog
// reads the fresh value from the native event target in capture phase, before
// Input's passive v-model proxy updates the parent ref. Typing stages that
// fresh value into the policy draft and does not persist it.
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

  function harnessFor(): { harness: McpQueryTimeoutHarness; inputRef: { value: string } } {
    const inputRef = { value: "" };
    const harness = createMcpQueryTimeoutHarness({
      source: dialogSource,
      input: inputRef,
      policyQueryTimeoutSecs: null,
    });
    return { harness, inputRef };
  }

  it("typing into the real Input stages the fresh value after debounce", async () => {
    vi.useFakeTimers();
    const { harness, inputRef } = harnessFor();

    const el = await mountInput({
      modelValue: inputRef,
      onInput: harness.onMcpQueryTimeoutInput,
    });

    el.value = "300";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    expect(harness.draft.value.queryTimeoutSecs).toBeNull();

    vi.advanceTimersByTime(300);
    expect(harness.draft.value.queryTimeoutSecs).toBe(300);
  });

  it("staging before the debounce elapses keeps the fresh value in the draft only", async () => {
    vi.useFakeTimers();
    const { harness, inputRef } = harnessFor();

    const el = await mountInput({
      modelValue: inputRef,
      onInput: harness.onMcpQueryTimeoutInput,
    });

    el.value = "120";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    harness.stageMcpQueryTimeoutDraft();
    expect(harness.draft.value.queryTimeoutSecs).toBe(120);
  });

  it("rapid typing in the real DOM coalesces into one draft update of the last value", async () => {
    vi.useFakeTimers();
    const { harness, inputRef } = harnessFor();

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

    expect(harness.draft.value.queryTimeoutSecs).toBe(123);
  });
});
