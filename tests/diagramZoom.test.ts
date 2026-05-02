import { strict as assert } from "node:assert";
import test from "node:test";
import {
  clampDiagramZoom,
  zoomFromGestureScale,
  zoomFromWheelDelta,
} from "../src/lib/diagramZoom.ts";

test("clamps diagram zoom to supported bounds", () => {
  assert.equal(clampDiagramZoom(0.2), 0.6);
  assert.equal(clampDiagramZoom(2), 1.5);
  assert.equal(clampDiagramZoom(1.234), 1.23);
});

test("maps trackpad pinch wheel delta to smooth zoom changes", () => {
  assert.ok(zoomFromWheelDelta(1, -120) > 1);
  assert.ok(zoomFromWheelDelta(1, 120) < 1);
});

test("maps WebKit gesture scale from the gesture start zoom", () => {
  assert.equal(zoomFromGestureScale(1, 1.25), 1.25);
  assert.equal(zoomFromGestureScale(1, 4), 1.5);
});
