import { strict as assert } from "node:assert";
import { test } from "vitest";
import { Position } from "@vue-flow/core";
import {
  alignWaypointsToEndpoints,
  collapseColinearPoints,
  dedupePoints,
  handlesFromWaypoints,
  pathHitsObstacles,
  pathSkimsEndpoints,
  pointsToSvgPath,
  polylineLength,
  routeOrthogonalAroundObstacles,
  type ObstacleRect,
} from "../../apps/desktop/src/lib/diagram/edge-obstacle-router.ts";
import { EDGE_ROUTE_OFFSET } from "../../apps/desktop/src/lib/diagram/diagram-constants.ts";

test("pointsToSvgPath and dedupePoints", () => {
  assert.equal(pointsToSvgPath([]), "");
  assert.equal(pointsToSvgPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), "M1,2 L3,4");
  assert.deepEqual(
    dedupePoints([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10.2, y: 0 },
    ]),
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  );
});

test("collapseColinearPoints removes middle points on a straight run", () => {
  assert.deepEqual(
    collapseColinearPoints([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]),
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ],
  );
});

test("pathHitsObstacles detects crossing segments", () => {
  const obstacle: ObstacleRect = {
    id: "block",
    x: 40,
    y: 40,
    width: 100,
    height: 100,
    kind: "table",
  };
  assert.equal(
    pathHitsObstacles(
      [
        { x: 0, y: 90 },
        { x: 200, y: 90 },
      ],
      [obstacle],
    ),
    true,
  );
  assert.equal(
    pathHitsObstacles(
      [
        { x: 0, y: 10 },
        { x: 200, y: 10 },
      ],
      [obstacle],
    ),
    false,
  );
});

test("pathSkimsEndpoints detects middle segment on table border", () => {
  const tall: ObstacleRect = { id: "tall", x: 0, y: 0, width: 360, height: 600, kind: "table" };
  assert.equal(
    pathSkimsEndpoints(
      [
        { x: 360, y: 100 },
        { x: 396, y: 100 },
        { x: 360, y: 100 },
        { x: 360, y: 400 },
        { x: 396, y: 400 },
        { x: 500, y: 400 },
      ],
      [tall],
    ),
    true,
  );
  assert.equal(
    pathSkimsEndpoints(
      [
        { x: 360, y: 100 },
        { x: 396, y: 100 },
        { x: 396, y: 400 },
        { x: 464, y: 400 },
        { x: 500, y: 400 },
      ],
      [tall],
    ),
    false,
  );
});

test("routeOrthogonalAroundObstacles returns a clear orthogonal path", () => {
  const obstacle: ObstacleRect = {
    id: "mid",
    x: 80,
    y: 40,
    width: 40,
    height: 40,
    kind: "table",
  };
  const path = routeOrthogonalAroundObstacles({
    source: { x: 0, y: 0 },
    target: { x: 200, y: 0 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    obstacles: [obstacle],
    endpointIds: ["a", "b"],
  });
  assert.ok(path);
  assert.ok(path!.length >= 2);
  assert.equal(pathHitsObstacles(path!, [obstacle]), false);
});

test("routeOrthogonalAroundObstacles prefers short stubbed corridor over far detour", () => {
  const path = routeOrthogonalAroundObstacles({
    source: { x: 0, y: 0 },
    target: { x: 100, y: 50 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    obstacles: [],
    endpointIds: ["a", "b"],
  });
  assert.ok(path);
  const farDetourLen = polylineLength([
    { x: 0, y: 0 },
    { x: EDGE_ROUTE_OFFSET, y: 0 },
    { x: 100 + EDGE_ROUTE_OFFSET, y: 0 },
    { x: 100 + EDGE_ROUTE_OFFSET, y: 50 },
    { x: 100 - EDGE_ROUTE_OFFSET, y: 50 },
    { x: 100, y: 50 },
  ]);
  assert.ok(polylineLength(path!) < farDetourLen);
});

test("routeOrthogonalAroundObstacles does not skim tall endpoint table border", () => {
  const tall: ObstacleRect = { id: "tall", x: 0, y: 0, width: 360, height: 600, kind: "table" };
  const other: ObstacleRect = { id: "other", x: 500, y: 400, width: 360, height: 120, kind: "table" };
  const rightEdge = 360;
  const path = routeOrthogonalAroundObstacles({
    source: { x: rightEdge, y: 120 },
    target: { x: 500, y: 460 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    obstacles: [tall, other],
    endpointIds: ["tall", "other"],
    offset: EDGE_ROUTE_OFFSET,
  });
  assert.ok(path);
  assert.equal(pathSkimsEndpoints(path!, [tall, other]), false);

  for (let i = 1; i < path!.length - 2; i++) {
    const a = path![i];
    const b = path![i + 1];
    const verticalOnBorder = Math.abs(a.x - rightEdge) <= 0.5 && Math.abs(b.x - rightEdge) <= 0.5;
    const run = Math.abs(a.y - b.y);
    assert.ok(!(verticalOnBorder && run > EDGE_ROUTE_OFFSET), `middle segment skims right edge: ${JSON.stringify([a, b])}`);
  }
});

test("alignWaypointsToEndpoints rejects paths that skim endpoints", () => {
  const tall: ObstacleRect = { id: "tall", x: 0, y: 0, width: 360, height: 600, kind: "table" };
  const other: ObstacleRect = { id: "other", x: 500, y: 400, width: 360, height: 120, kind: "table" };
  const aligned = alignWaypointsToEndpoints(
    [
      { x: 360, y: 120 },
      { x: 360, y: 460 },
      { x: 500, y: 460 },
    ],
    360,
    120,
    500,
    460,
    { obstacles: [tall, other], endpointIds: ["tall", "other"] },
  );
  assert.equal(aligned, null);
});

test("handlesFromWaypoints and alignWaypointsToEndpoints", () => {
  const handles = handlesFromWaypoints([
    { x: 0, y: 50 },
    { x: 40, y: 50 },
    { x: 40, y: 100 },
    { x: 120, y: 100 },
  ]);
  assert.deepEqual(handles, { sourceHandle: "right", targetHandle: "left-target" });
  assert.equal(handlesFromWaypoints([{ x: 0, y: 0 }]), null);

  const aligned = alignWaypointsToEndpoints(
    [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 80 },
      { x: 100, y: 80 },
    ],
    10,
    20,
    200,
    90,
  );
  assert.ok(aligned);
  assert.deepEqual(aligned![0], { x: 10, y: 20 });
  assert.deepEqual(aligned![aligned!.length - 1], { x: 200, y: 90 });
});
