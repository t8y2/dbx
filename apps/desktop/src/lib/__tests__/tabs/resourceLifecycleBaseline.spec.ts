import { describe, expect, it } from "vitest";
import { encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import { estimateQueryResultBytes } from "@/lib/tabs/queryResultSize";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately, sidebarDataOpenDiagnostics } from "@/lib/sidebar/sidebarDataOpenCoordinator";

describe("resource lifecycle performance harness", () => {
  it("records deterministic serialization and memory-estimation measurements", () => {
    const result = {
      columns: ["id", "label", "payload"],
      rows: Array.from({ length: 25_000 }, (_, index) => [index, `row-${index}`, "x".repeat(64)]),
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const estimateStartedAt = performance.now();
    const estimatedBytes = estimateQueryResultBytes(result);
    const estimateDurationMs = performance.now() - estimateStartedAt;
    const serializeStartedAt = performance.now();
    const encodedBytes = encodeTabResultSnapshot({ result, cachedAt: 1 }).byteLength;
    const serializationDurationMs = performance.now() - serializeStartedAt;

    console.info("[resource-lifecycle-baseline]", JSON.stringify({ rows: result.rows.length, estimatedBytes, encodedBytes, estimateDurationMs, serializationDurationMs }));
    expect(estimatedBytes).toBeGreaterThan(encodedBytes);
    expect(estimateDurationMs).toBeLessThan(250);
    expect(serializationDurationMs).toBeLessThan(1_500);
  });
});

describe("rapid table-open performance harness", () => {
  it("coalesces a 100-request burst to one active and one latest queued request", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed: number[] = [];
    const startedAt = performance.now();
    runSidebarDataOpenImmediately({ connectionKey: "connection" }, async (request) => {
      await blocked;
      if (request.isCurrent()) committed.push(0);
    });
    for (let index = 1; index < 100; index += 1) {
      runSidebarDataOpenImmediately({ connectionKey: "connection" }, (request) => {
        if (request.isCurrent()) committed.push(index);
      });
    }
    const enqueueDurationMs = performance.now() - startedAt;
    const burstDiagnostics = sidebarDataOpenDiagnostics();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const totalDurationMs = performance.now() - startedAt;
    console.info("[rapid-table-open-baseline]", JSON.stringify({ enqueueDurationMs, totalDurationMs, ...burstDiagnostics }));

    expect(burstDiagnostics).toEqual({ activeTasks: 1, queuedTasks: 1, trackedRequests: 2 });
    expect(committed).toEqual([99]);
    cancelPendingSidebarDataOpen();
  });
});
