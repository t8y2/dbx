import { expect, it, vi } from "vitest";
import { createRelationalNavigationQueue } from "@/lib/sidebar/relationalNavigationQueue";

it("bounds concurrency, promotes queued interaction and reuses the in-flight page", async () => {
  const queue = createRelationalNavigationQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue("a", async () => {
    order.push("a");
    await gate;
  });
  const second = queue.enqueue("b", async () => {
    order.push("b");
    await gate;
  });
  await Promise.resolve();
  await Promise.resolve();
  const third = queue.enqueue("c", async () => {
    order.push("c");
  });
  const fourth = queue.enqueue("d", async () => {
    order.push("d");
  });
  const duplicate = vi.fn();
  expect(queue.enqueue("d", duplicate, true)).toBe(fourth);
  expect(queue.enqueue("a", duplicate, true)).toBe(first);
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["a", "b"]);
  release();
  await Promise.all([first, second, third, fourth]);
  expect(order).toEqual(["a", "b", "d", "c"]);
  expect(duplicate).not.toHaveBeenCalled();
});

it("cancels queued pages without interrupting a running read and recovers after failure", async () => {
  const queue = createRelationalNavigationQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue("active-a", () => gate);
  const second = queue.enqueue("active-b", () => gate);
  await Promise.resolve();
  const cancelled = vi.fn();
  const pending = queue.enqueue("queued", cancelled);
  queue.cancel((key) => key === "queued");
  await pending;
  expect(cancelled).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second]);
  await expect(
    queue.enqueue("failed", async () => {
      throw new Error("catalog unavailable");
    }),
  ).rejects.toThrow("catalog unavailable");
  const recovered = vi.fn().mockResolvedValue(undefined);
  await queue.enqueue("recovered", recovered);
  expect(recovered).toHaveBeenCalledOnce();
});
