import { strict as assert } from "node:assert";
import { test } from "vitest";
import { midpointAlongPolyline, pointAlongPolyline } from "../../apps/desktop/src/lib/diagram/edge-obstacle-router.ts";

test("pointAlongPolyline returns endpoints at 0 and 1", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  assert.deepEqual(pointAlongPolyline(points, 0), { x: 0, y: 0 });
  assert.deepEqual(pointAlongPolyline(points, 1), { x: 100, y: 0 });
});

test("pointAlongPolyline interpolates by arc length", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  // Total length 200; t=0.25 → 50 along first segment
  const p = pointAlongPolyline(points, 0.25);
  assert.equal(p.x, 50);
  assert.equal(p.y, 0);
  // t=0.75 → 150 → mid of second segment
  const q = pointAlongPolyline(points, 0.75);
  assert.equal(q.x, 100);
  assert.equal(q.y, 50);
});

test("midpointAlongPolyline matches t=0.5", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  assert.deepEqual(midpointAlongPolyline(points), pointAlongPolyline(points, 0.5));
});
