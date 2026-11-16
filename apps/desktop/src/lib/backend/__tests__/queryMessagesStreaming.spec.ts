import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

it("filters query messages by execution and returns listener cleanup", async () => {
  const unlisten = vi.fn();
  mocks.listen.mockResolvedValue(unlisten);
  const onMessages = vi.fn();
  const { subscribeQueryMessages } = await import("../tauri");
  const cleanup = await subscribeQueryMessages("run-1", onMessages);
  expect(mocks.listen).toHaveBeenCalledWith("query-messages", expect.any(Function));
  const listener = mocks.listen.mock.calls[0][1];
  const messages = [{ severity: "NOTICE", message: "hello" }];
  listener({ payload: { executionId: "run-2", messages } });
  expect(onMessages).not.toHaveBeenCalled();
  listener({ payload: { executionId: "run-1", messages } });
  expect(onMessages).toHaveBeenCalledWith(messages);
  cleanup();
  expect(unlisten).toHaveBeenCalledOnce();
});
