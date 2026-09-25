import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpQueryTimeoutHarness } from "./mcpQueryTimeoutHarness";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Behavioral coverage for the debounce/flush runtime (review finding): the
// string assertions above cannot catch a broken runtime path, so this harness
// extracts the real debounce block from the .vue source, compiles it, and
// drives it with fake timers + mocked deps to assert actual save behaviour.

function nativeInputEvent(value: string, badInput = false): Event {
  return { currentTarget: { value, validity: { badInput } } } as unknown as Event;
}

function expectQueryTimeoutSave(saveMcpPolicy: ReturnType<typeof vi.fn>, queryTimeoutSecs: number | null) {
  expect(saveMcpPolicy).toHaveBeenCalled();
  expect(saveMcpPolicy.mock.calls.at(-1)?.[0]).toEqual({ queryTimeoutSecs });
}

describe("EditorSettingsDialog MCP query timeout debounce runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves a typed value once the debounce window elapses", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("300"));
    expect(saveMcpPolicy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(saveMcpPolicy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expectQueryTimeoutSave(saveMcpPolicy, 300);
  });

  it("reports saving immediately and saved after the persistence callback", () => {
    const setSaveStatus = vi.fn();
    const saveMcpPolicy = vi.fn((_partial, callbacks?: { onSuccess?: () => void }) => callbacks?.onSuccess?.());
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy, setSaveStatus });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("300"));
    expect(setSaveStatus).toHaveBeenLastCalledWith("saving");
    harness.flushMcpQueryTimeoutSave();
    expect(setSaveStatus).toHaveBeenLastCalledWith("saved");
  });

  it("coalesces rapid typing into a single save", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("1"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("12"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("123"));
    vi.advanceTimersByTime(300);
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expectQueryTimeoutSave(saveMcpPolicy, 123);
  });

  it("flush persists a pending value before the debounce elapses", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("120"));
    harness.flushMcpQueryTimeoutSave();
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    expectQueryTimeoutSave(saveMcpPolicy, 120);
    // Flushing again with nothing pending is a no-op.
    harness.flushMcpQueryTimeoutSave();
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
  });

  it("flush after the timer fired does not double-save", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("60"));
    vi.advanceTimersByTime(300);
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
    harness.flushMcpQueryTimeoutSave();
    expect(saveMcpPolicy).toHaveBeenCalledTimes(1);
  });

  it("retains a pending value while another MCP policy mutation holds the gate", () => {
    const saveMcpPolicy = vi.fn();
    const policyMutationBlocked = { value: true };
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy, policyMutationBlocked });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("60"));
    vi.advanceTimersByTime(300);
    expect(saveMcpPolicy).not.toHaveBeenCalled();

    policyMutationBlocked.value = false;
    harness.flushMcpQueryTimeoutSave();
    expectQueryTimeoutSave(saveMcpPolicy, 60);
  });

  it("empty input schedules null (inherit the connection)", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: 300, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent(""));
    harness.flushMcpQueryTimeoutSave();
    expectQueryTimeoutSave(saveMcpPolicy, null);
  });

  it("zero input persists 0 (no limit)", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: null, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("0"));
    harness.flushMcpQueryTimeoutSave();
    expectQueryTimeoutSave(saveMcpPolicy, 0);
  });

  it("invalid input cancels the pending save and reverts the field", () => {
    const saveMcpPolicy = vi.fn();
    const toast = vi.fn();
    const input = { value: "1.5" };
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input, policyQueryTimeoutSecs: null, saveMcpPolicy, toast });
    const event = nativeInputEvent("1.5");
    harness.onMcpQueryTimeoutInput(event);
    // Invalid input must not schedule anything.
    vi.advanceTimersByTime(300);
    expect(saveMcpPolicy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    // The bound ref is reverted to the persisted value ("" == inherit).
    expect(input.value).toBe("");
    // The native input is reverted too (one-way binding needs the DOM write).
    expect((event.currentTarget as { value: string }).value).toBe("");
  });

  it("does not treat a bad number-input intermediate state as inherit", () => {
    const saveMcpPolicy = vi.fn();
    const harness = createMcpQueryTimeoutHarness({ source: dialogSource, input: { value: "" }, policyQueryTimeoutSecs: 90, saveMcpPolicy });
    harness.onMcpQueryTimeoutInput(nativeInputEvent("45"));
    vi.advanceTimersByTime(100);
    harness.onMcpQueryTimeoutInput(nativeInputEvent("", true));
    vi.advanceTimersByTime(200);
    expectQueryTimeoutSave(saveMcpPolicy, 45);
    expect(saveMcpPolicy.mock.calls.some(([partial]) => partial.queryTimeoutSecs === null)).toBe(false);
  });
});
