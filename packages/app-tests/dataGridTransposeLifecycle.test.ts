import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { useDataGridCanvasRuntime, type DataGridAnimationFrameDriver } from "../../apps/desktop/src/composables/useDataGridCanvasRuntime.ts";
import { useDataGridScrollbars } from "../../apps/desktop/src/composables/useDataGridScrollbars.ts";
import { restoreDataGridAfterTranspose, transposeRecordIndexesForMode } from "../../apps/desktop/src/lib/dataGrid/dataGridTranspose.ts";

type TestScroller = HTMLElement & { clientHeight: number; scrollHeight: number };

function createScroller(scrollWidth: number, clientWidth: number, clientHeight: number, scrollHeight = 1200): TestScroller {
  return {
    children: [],
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight,
    scrollWidth,
    clientWidth,
    clientHeight,
  } as unknown as TestScroller;
}

function createFrameDriver() {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const driver: DataGridAnimationFrameDriver = {
    request(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancel(id) {
      frames.delete(id);
    },
  };
  return {
    driver,
    runAll() {
      while (frames.size > 0) {
        const pending = [...frames.entries()];
        frames.clear();
        pending.forEach(([, callback]) => callback(0));
      }
    },
  };
}

function createObserverHarness() {
  const callbacks: ResizeObserverCallback[] = [];
  const observed: Element[] = [];
  return {
    observed,
    create(callback: ResizeObserverCallback) {
      callbacks.push(callback);
      return {
        disconnect() {},
        observe(element: Element) {
          observed.push(element);
        },
      } as unknown as ResizeObserver;
    },
    fireLatest() {
      callbacks.at(-1)?.([], {} as ResizeObserver);
    },
  };
}

test("restores a wide canvas grid after single-row and multi-row transpose remounts", () => {
  const frames = createFrameDriver();
  const canvasObservers = createObserverHarness();
  let viewport: TestScroller | null = createScroller(1600, 600, 320);
  let syncedViewportHeight = 0;
  let hasHorizontalOverflow = false;

  const canvasRuntime = useDataGridCanvasRuntime({
    draw() {},
    syncViewport() {
      syncedViewportHeight = viewport?.clientHeight ?? 0;
    },
    getViewport: () => viewport,
    frameDriver: frames.driver,
    createResizeObserver: canvasObservers.create,
  });
  const scrollbarsRuntime = useDataGridScrollbars({
    update() {
      hasHorizontalOverflow = !!viewport && viewport.scrollWidth - viewport.clientWidth > 1;
    },
    getScroller: () => viewport,
    applyHorizontalDrag() {},
    applyVerticalDrag() {},
    frameDriver: frames.driver,
  });

  canvasRuntime.observeViewport();
  scrollbarsRuntime.observeScroller();
  frames.runAll();

  for (const { mode, multiRow, expectedRecordIndexes, savedScrollLeft } of [
    { mode: "single-row", multiRow: false, expectedRecordIndexes: [1], savedScrollLeft: 320 },
    { mode: "multi-row", multiRow: true, expectedRecordIndexes: [0, 1, 2], savedScrollLeft: 540 },
  ]) {
    assert.deepEqual(
      transposeRecordIndexesForMode({
        multiRow,
        activeRecordIndex: 1,
        totalRecords: 3,
        visibleRecordIndexes: [0, 1, 2],
      }),
      expectedRecordIndexes,
    );
    viewport!.scrollLeft = savedScrollLeft;
    viewport = null;
    canvasRuntime.observeViewport();
    scrollbarsRuntime.observeScroller();
    frames.runAll();
    assert.equal(hasHorizontalOverflow, false, `${mode} transpose should remove the normal grid scrollbar`);

    viewport = createScroller(1600, 600, 320);
    restoreDataGridAfterTranspose({
      scroller: viewport,
      scrollLeftBeforeTranspose: savedScrollLeft,
      attachCanvasResizeObserver: canvasRuntime.observeViewport,
      refreshGridScrollerMetrics: scrollbarsRuntime.observeScroller,
    });
    frames.runAll();

    assert.equal(viewport.scrollLeft, savedScrollLeft, `${mode} transpose should restore horizontal position`);
    assert.equal(hasHorizontalOverflow, true, `${mode} transpose should restore the custom scrollbar`);
    assert.equal(canvasObservers.observed.at(-1), viewport, `${mode} transpose should observe the remounted canvas scroller`);

    viewport.clientHeight = 180;
    canvasObservers.fireLatest();
    assert.equal(syncedViewportHeight, 180, `${mode} transpose should react to a later container resize`);
  }

  canvasRuntime.dispose();
  scrollbarsRuntime.dispose();
});

test("restores the vertical grid position after a keyboard transpose round trip", () => {
  const viewport = createScroller(600, 600, 320, 2600);

  restoreDataGridAfterTranspose({
    scroller: viewport,
    scrollLeftBeforeTranspose: 0,
    scrollTopBeforeTranspose: 1300,
    attachCanvasResizeObserver() {},
    refreshGridScrollerMetrics() {},
  });

  assert.equal(viewport.scrollTop, 1300);

  restoreDataGridAfterTranspose({
    scroller: viewport,
    scrollLeftBeforeTranspose: 0,
    scrollTopBeforeTranspose: 2500,
    attachCanvasResizeObserver() {},
    refreshGridScrollerMetrics() {},
  });

  assert.equal(viewport.scrollTop, 2280, "restored position should stay within the remounted grid bounds");
});

test("error result recovery participates in canvas observer remounts", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /watch\(\s*\[useCanvasGridRows, hasVisibleRows, isErrorResult\]/);
});
