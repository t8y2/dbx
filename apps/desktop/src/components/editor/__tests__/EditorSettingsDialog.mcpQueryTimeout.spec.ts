import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpQueryTimeoutHarness, extractMcpQueryTimeoutDebounceBlock } from "./mcpQueryTimeoutHarness";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// The debounce block stages a query timeout into the policy draft. It must not
// persist: explicit save is the only write, and close/discard drops the draft.

function nativeInputEvent(value: string, badInput = false): Event {
  return { currentTarget: { value, validity: { badInput } } } as unknown as Event;
}

function expectStagedTimeout(harness: ReturnType<typeof createMcpQueryTimeoutHarness>, queryTimeoutSecs: number | null) {
  expect(harness.draft.value.queryTimeoutSecs).toBe(queryTimeoutSecs);
}

describe("EditorSettingsDialog MCP query timeout debounce runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stages a typed value into the draft once the debounce window elapses, without persisting", () => {
    const block = extractMcpQueryTimeoutDebounceBlock(dialogSource);
    expect(block).not.toContain("saveMcpPolicy");
    expect(block).not.toContain("updateMcpGlobalPolicy");

    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("300"));
    expect(harness.draft.value.queryTimeoutSecs).toBeNull();
    vi.advanceTimersByTime(299);
    expect(harness.draft.value.queryTimeoutSecs).toBeNull();
    vi.advanceTimersByTime(1);
    expectStagedTimeout(harness, 300);
  });

  it("coalesces rapid typing into a single draft update", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("1"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("12"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("123"));
    vi.advanceTimersByTime(300);
    expectStagedTimeout(harness, 123);
  });

  it("stages a pending value before the debounce elapses", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("120"));
    harness.stageMcpQueryTimeoutDraft();
    expectStagedTimeout(harness, 120);
    harness.stageMcpQueryTimeoutDraft();
    expectStagedTimeout(harness, 120);
  });

  it("staging after the timer fired does not change the draft again", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("60"));
    vi.advanceTimersByTime(300);
    expectStagedTimeout(harness, 60);
    harness.draft.value.queryTimeoutSecs = 1;
    harness.stageMcpQueryTimeoutDraft();
    expect(harness.draft.value.queryTimeoutSecs).toBe(1);
  });

  it("empty input stages null (inherit the connection)", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: 300 });
    harness.onMcpQueryTimeoutInput(nativeInputEvent(""));
    harness.stageMcpQueryTimeoutDraft();
    expectStagedTimeout(harness, null);
  });

  it("zero input stages 0 (no limit)", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("0"));
    harness.stageMcpQueryTimeoutDraft();
    expectStagedTimeout(harness, 0);
  });

  it("invalid input cancels the pending stage and reverts the field", () => {
    const toast = vi.fn();
    const input = { value: "1.5" };
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input, policyQueryTimeoutSecs: null, toast });
    const event = nativeInputEvent("1.5");
    harness.onMcpQueryTimeoutInput(event);
    vi.advanceTimersByTime(300);
    expect(harness.draft.value.queryTimeoutSecs).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
    expect((event.currentTarget as { value: string }).value).toBe("");
  });

  it("does not treat a bad number-input intermediate state as inherit", () => {
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: 90 });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("45"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("", true));
    vi.advanceTimersByTime(200);
    expectStagedTimeout(harness, 45);
  });

  it("close confirmation stages the draft and does not persist, and unmount does not write", () => {
    const closeStart = dialogSource.indexOf("function requestCloseSettings");
    const closeEnd = dialogSource.indexOf("function onSettingsRootOpenChange");
    const closeFn = dialogSource.slice(closeStart, closeEnd);
    expect(closeFn).toContain("stageMcpQueryTimeoutDraft()");
    expect(closeFn).not.toContain("updateMcpGlobalPolicy");
    expect(closeFn).not.toContain("saveMcpGlobalPolicy");

    const discardStart = dialogSource.indexOf("function discardUnsavedSettingsAndClose");
    const discardFn = dialogSource.slice(discardStart, dialogSource.indexOf("interface TableColumnTemplateOverrideRow"));
    expect(discardFn).not.toContain("updateMcpGlobalPolicy");
    expect(discardFn).not.toContain("commitMcpPolicyDraft");
    expect(discardFn).not.toContain("stageMcpQueryTimeoutDraft");

    const unmountStart = dialogSource.lastIndexOf("onUnmounted(() => {");
    const unmountEnd = dialogSource.indexOf("});", unmountStart);
    const unmountFn = dialogSource.slice(unmountStart, unmountEnd);
    expect(unmountFn).not.toContain("stageMcpQueryTimeoutDraft");
    expect(unmountFn).not.toContain("updateMcpGlobalPolicy");
    expect(unmountFn).not.toContain("commitMcpPolicyDraft");
  });
});
