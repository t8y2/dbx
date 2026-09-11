import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpQueryTimeoutHarness } from "./mcpQueryTimeoutHarness";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

function handlerBlock(): string {
  const start = dialogSource.indexOf("function onMcpQueryTimeoutInput(");
  const end = dialogSource.indexOf("const mcpSelectableConnections", start);
  if (start < 0 || end < 0) throw new Error("Missing onMcpQueryTimeoutInput handler block");
  return dialogSource.slice(start, end);
}

// Regression for the MCP query-timeout input: decimal values like 1.5 were
// silently Math.round-ed to 2 and saved, contradicting the "non-negative whole
// number" label. The UI must reject non-integers with the existing invalid
// toast instead of silently rewriting them.
describe("EditorSettingsDialog MCP query timeout validation", () => {
  it("rejects non-integers instead of rounding them", () => {
    const block = handlerBlock();
    // The invalid path must test for integer-ness, not just finite + non-negative.
    expect(block).toMatch(/Number\.isInteger\(parsed\)/);
    // The valid save path must NOT wrap the value in Math.round anymore.
    expect(block).not.toContain("Math.round(parsed)");
    // A decimal input falls through to the invalid toast + revert branch.
    expect(block).toContain('toast(t("settings.mcpQueryTimeoutInvalid"), 5000)');
    expect(block).toMatch(/mcpQueryTimeoutInput\.value\s*=\s*reverted/);
  });

  it("keeps null (inherit) and zero (no limit) working", () => {
    const block = handlerBlock();
    // Empty input still schedules null (inherit the connection).
    expect(block).toContain("mcpQueryTimeoutPendingValue = null");
    // A valid integer is scheduled with the exact value.
    expect(block).toContain("mcpQueryTimeoutPendingValue = parsed");
    // The invalid branch cancels any pending save instead of persisting garbage.
    expect(block).toContain("mcpQueryTimeoutPendingValue = undefined");
  });
});

// Regression for #8616: the input previously bound @change (fires only on
// blur/Enter), so typing a value and closing the window dropped the change and
// the persisted policy kept its old value. The fix binds @input (fires on every
// keystroke), debounces the write, and flushes any pending value on close.
describe("EditorSettingsDialog MCP query timeout persistence", () => {
  it("binds @input instead of @change so typing schedules a save immediately", () => {
    const inputLine = dialogSource.split("\n").find((line) => line.includes('id="mcp-query-timeout"'));
    expect(inputLine).toBeTruthy();
    // The legacy @change binding must not come back.
    expect(inputLine).not.toContain("@change");
    // Typing must trigger the save path on every keystroke.
    expect(inputLine).toContain('@input.capture="onMcpQueryTimeoutInput"');
  });

  it("uses capture-phase input handling so the handler reads the fresh native value before Input's passive v-model update", () => {
    const inputLine = dialogSource.split("\n").find((line) => line.includes('id="mcp-query-timeout"'));
    expect(inputLine).toBeTruthy();
    expect(inputLine).toContain('v-model="mcpQueryTimeoutInput"');
    expect(inputLine).toContain('@input.capture="onMcpQueryTimeoutInput"');
  });

  it("handler reads the value from the native event target, not the ref", () => {
    const block = handlerBlock();
    expect(block).toContain("onMcpQueryTimeoutInput(event: Event)");
    expect(block).toMatch(/const target = event\.currentTarget as HTMLInputElement/);
    expect(block).toContain("target.value.trim()");
  });

  it("debounces the persist so rapid typing coalesces into one write", () => {
    const block = handlerBlock();
    expect(block).toContain("MCP_QUERY_TIMEOUT_SAVE_DEBOUNCE_MS");
    expect(block).toMatch(/setTimeout\([\s\S]*MCP_QUERY_TIMEOUT_SAVE_DEBOUNCE_MS\)/);
    expect(block).toContain("clearTimeout(mcpQueryTimeoutSaveTimer)");
    expect(block).toContain("flushMcpQueryTimeoutSave()");
  });

  it("flushes the pending value when the settings dialog closes", () => {
    const closeBlockStart = dialogSource.indexOf("function requestCloseSettings(");
    const closeBlockEnd = dialogSource.indexOf("function onSettingsRootOpenChange", closeBlockStart);
    expect(closeBlockStart).toBeGreaterThan(-1);
    expect(closeBlockEnd).toBeGreaterThan(closeBlockStart);
    const closeBlock = dialogSource.slice(closeBlockStart, closeBlockEnd);
    expect(closeBlock).toContain("flushMcpQueryTimeoutSave()");

    // The unmount path must also flush, covering a hard window close.
    const unmountIndex = dialogSource.lastIndexOf("onUnmounted(() =>");
    expect(unmountIndex).toBeGreaterThan(-1);
    const unmountTail = dialogSource.slice(unmountIndex);
    expect(unmountTail).toContain("flushMcpQueryTimeoutSave()");
  });

  it("persists through saveMcpPolicy with the pending value", () => {
    const flushBlockStart = dialogSource.indexOf("function flushMcpQueryTimeoutSave()");
    const flushBlockEnd = dialogSource.indexOf("const mcpSelectableConnections", flushBlockStart);
    expect(flushBlockStart).toBeGreaterThan(-1);
    expect(flushBlockEnd).toBeGreaterThan(flushBlockStart);
    const flushBlock = dialogSource.slice(flushBlockStart, flushBlockEnd);
    // The debounced timer hands the pending value to the existing save path.
    expect(flushBlock).toContain("queryTimeoutSecs: value");
    // A cleared pending value (no recent input) is a no-op.
    expect(flushBlock).toContain("mcpQueryTimeoutPendingValue === undefined");
  });
});

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
