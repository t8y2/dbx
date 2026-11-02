import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptSelectedCompletionWithRetry, type RetryCompletionAcceptanceOptions } from "../queryEditorCompletionAcceptance";

function createFakeView({ composing = false } = {}) {
  return {
    composing,
    compositionStarted: composing,
    state: {
      selection: { ranges: [{ anchor: 0, head: 0 }] },
    },
  };
}

type FakeView = ReturnType<typeof createFakeView>;

function createOptions(view: FakeView, overrides: Partial<RetryCompletionAcceptanceOptions> = {}) {
  const status: { value: "active" | "pending" | null } = { value: "active" };
  const options = {
    completionStatus: () => status.value,
    acceptCompletion: vi.fn(() => false),
    selectedCompletionIndex: () => null,
    selectFirstCompletion: vi.fn(() => true),
    retryDelayMs: 1,
    maxWaitMs: 10,
    onUnavailable: vi.fn(),
    onSettled: vi.fn(),
    isComposing: () => view.composing,
    ...overrides,
  } satisfies RetryCompletionAcceptanceOptions;
  return { options, status };
}

describe("acceptSelectedCompletionWithRetry IME guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts immediately when the completion is active and no retry is needed", () => {
    const view = createFakeView();
    const { options } = createOptions(view, {
      acceptCompletion: vi.fn(() => true),
    });

    const result = acceptSelectedCompletionWithRetry(view as never, options);

    expect(result.handled).toBe(true);
    expect(options.acceptCompletion).toHaveBeenCalledTimes(1);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it("drops the queued acceptance without calling onUnavailable once an IME composition starts while waiting", () => {
    const view = createFakeView();
    const { options } = createOptions(view);

    const result = acceptSelectedCompletionWithRetry(view as never, options);
    expect(result.handled).toBe(true);

    // The user started an IME composition before the retry fired: the queued
    // Enter belongs to the IME candidate list now, so the retry must drop the
    // acceptance silently instead of accepting a completion over the
    // composition or falling back to onUnavailable. The only accept attempt is
    // the initial synchronous one that happened before the composition began.
    view.composing = true;
    view.compositionStarted = true;
    vi.advanceTimersByTime(5);

    expect(options.acceptCompletion).toHaveBeenCalledTimes(1);
    expect(options.onUnavailable).not.toHaveBeenCalled();
    expect(options.onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying while waiting when no IME composition starts", () => {
    const view = createFakeView();
    const { options } = createOptions(view);

    acceptSelectedCompletionWithRetry(view as never, options);
    // One synchronous attempt on entry.
    expect(options.acceptCompletion).toHaveBeenCalledTimes(1);

    // First retry still sees an unacceptable completion and keeps waiting.
    vi.advanceTimersByTime(1);
    expect(options.acceptCompletion).toHaveBeenCalledTimes(2);
    expect(options.onUnavailable).not.toHaveBeenCalled();

    // No composition started, so the retry keeps its original semantics and
    // accepts as soon as the completion becomes acceptable.
    options.acceptCompletion.mockReturnValue(true);
    vi.advanceTimersByTime(1);
    expect(options.acceptCompletion).toHaveBeenCalledTimes(3);
    expect(options.onUnavailable).not.toHaveBeenCalled();
  });

  it("still calls onUnavailable when the completion never becomes acceptable and no composition starts", () => {
    const view = createFakeView();
    const { options } = createOptions(view, {
      isComposing: () => false,
      maxWaitMs: 10,
    });

    acceptSelectedCompletionWithRetry(view as never, options);
    vi.advanceTimersByTime(50);

    expect(options.onUnavailable).toHaveBeenCalledTimes(1);
  });
});
