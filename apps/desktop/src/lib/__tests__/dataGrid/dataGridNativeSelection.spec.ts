import { afterEach, describe, expect, it, vi } from "vitest";

import { beginDataGridNativeSelectionBlock, DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS, DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS, finishDataGridNativeSelectionBlock } from "@/lib/dataGrid/dataGridNativeSelection";

function selectionEnvironment() {
  const classes = new Set<string>();
  const removeAllRanges = vi.fn();
  return {
    classes,
    removeAllRanges,
    environment: {
      document: {
        documentElement: {
          classList: {
            add: (className: string) => classes.add(className),
            remove: (className: string) => classes.delete(className),
          },
        },
      },
      getSelection: () => ({ removeAllRanges }),
      setTimeout,
      clearTimeout,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("data grid native selection block", () => {
  it("blocks native selection immediately and clears an existing selection", () => {
    const { classes, removeAllRanges, environment } = selectionEnvironment();
    const owner = {};

    beginDataGridNativeSelectionBlock(owner, environment);

    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(true);
    expect(removeAllRanges).toHaveBeenCalledOnce();
  });

  it("keeps the application-level block across a fast component replacement", () => {
    vi.useFakeTimers();
    const { classes, environment } = selectionEnvironment();
    const owner = {};

    beginDataGridNativeSelectionBlock(owner, environment);
    finishDataGridNativeSelectionBlock(owner, environment);

    vi.advanceTimersByTime(DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS - 1);
    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(false);
  });

  it("cancels a pending release when another grid starts loading", () => {
    vi.useFakeTimers();
    const { classes, environment } = selectionEnvironment();
    const owner = {};

    finishDataGridNativeSelectionBlock(owner, environment);
    vi.advanceTimersByTime(DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS - 1);
    beginDataGridNativeSelectionBlock(owner, environment);
    vi.advanceTimersByTime(DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS);

    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(true);
  });

  it("does not let another grid release the application-level block", () => {
    vi.useFakeTimers();
    const { classes, environment } = selectionEnvironment();
    const loadingGrid = {};
    const finishedGrid = {};

    beginDataGridNativeSelectionBlock(loadingGrid, environment);
    finishDataGridNativeSelectionBlock(finishedGrid, environment);
    vi.advanceTimersByTime(DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS);

    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(true);

    finishDataGridNativeSelectionBlock(loadingGrid, environment);
    vi.advanceTimersByTime(DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS);
    expect(classes.has(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS)).toBe(false);
  });
});
