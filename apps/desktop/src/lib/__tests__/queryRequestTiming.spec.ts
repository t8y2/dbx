import { afterEach, expect, it, vi } from "vitest";
import { createQueryRequestTiming } from "../queryRequestTiming";

afterEach(() => vi.restoreAllMocks());

it("separates preparation, backend waits and local conversion across multiple calls", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const timing = createQueryRequestTiming(80);
  const value = await timing.run(async () => {
    now = 130;
    return "result";
  });
  expect(value).toBe("result");
  now = 140;
  await timing.run(async () => {
    now = 160;
  });
  now = 165;
  const result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 99 };
  expect(timing.finish(result)).toMatchObject({ client_prepare_ms: 20, client_request_wait_ms: 50, client_result_ms: 15, timing_page_count: 2, execution_time_ms: 99 });
});

it("does not invent request timings for a local command and propagates failures without replay", async () => {
  const result = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 };
  expect(createQueryRequestTiming(0).finish(result)).not.toHaveProperty("client_request_wait_ms");
  const call = vi.fn().mockRejectedValue(new Error("query failed"));
  await expect(createQueryRequestTiming(0).run(call)).rejects.toThrow("query failed");
  expect(call).toHaveBeenCalledTimes(1);
});
