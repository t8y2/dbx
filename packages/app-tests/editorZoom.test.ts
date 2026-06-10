import { strict as assert } from "node:assert";
import { test } from "vitest";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "../../apps/desktop/src/lib/editorZoom.ts";

test("clamps editor font size to supported bounds", () => {
  assert.equal(clampEditorFontSize(8), 10);
  assert.equal(clampEditorFontSize(30), 24);
  assert.equal(clampEditorFontSize(13.257), 13.26);
});

test("maps trackpad pinch wheel delta to smooth font size changes", () => {
  assert.ok(fontSizeFromWheelDelta(13, -120) > 13);
  assert.ok(fontSizeFromWheelDelta(13, 120) < 13);
});

test("maps WebKit gesture scale from the gesture start font size", () => {
  assert.equal(fontSizeFromGestureScale(13, 1.25), 16.25);
  assert.equal(fontSizeFromGestureScale(13, 4), 24);
});

test("debounces editor zoom commits and keeps only the latest font size", async () => {
  const committed: number[] = [];
  const scheduler = createEditorZoomCommitScheduler((fontSize) => committed.push(fontSize), 10);

  scheduler.schedule(13.5);
  scheduler.schedule(14.25);

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(committed, [14.25]);
});

test("flushes a pending editor zoom commit immediately", () => {
  const committed: number[] = [];
  const scheduler = createEditorZoomCommitScheduler((fontSize) => committed.push(fontSize), 50);

  scheduler.schedule(15.75);
  scheduler.flush();

  assert.deepEqual(committed, [15.75]);
  assert.equal(scheduler.hasPendingCommit(), false);
});
