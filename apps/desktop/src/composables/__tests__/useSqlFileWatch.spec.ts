// @vitest-environment happy-dom
import { effectScope, nextTick, ref, type EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ watchSqlFileFolder: mocks.watch }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
import { useSqlFileWatch } from "../useSqlFileWatch";
let scopes: EffectScope[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.watch.mockImplementation(async () => vi.fn(async () => {}));
});
afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes = [];
  vi.useRealTimers();
});
async function mount(changed = vi.fn(async () => {})) {
  const paths = ref<{ path: string; recursive: boolean; revision?: string }[]>([{ path: "/sql", recursive: true }]);
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() => useSqlFileWatch(() => paths.value, changed));
  await nextTick();
  await Promise.resolve();
  return { paths, scope, changed, notify: mocks.watch.mock.calls.at(-1)![2] as () => void };
}
describe("native SQL folder notifications", () => {
  it("rebinds bounded directory watches when the scanned directory set changes", async () => {
    const stop = vi.fn(async () => {});
    mocks.watch.mockResolvedValueOnce(stop);
    const { paths } = await mount();
    paths.value[0].revision = '["/sql/new"]';
    await nextTick();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.watch).toHaveBeenCalledTimes(2);
  });
  it("retries a failed watcher when its folder is refreshed", async () => {
    mocks.watch.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const { paths } = await mount();
    paths.value = [{ path: "/sql", recursive: true }];
    await nextTick();
    expect(mocks.watch).toHaveBeenCalledTimes(2);
  });
  it("debounces save bursts rather than rescanning for every native event", async () => {
    const { notify, changed } = await mount();
    notify();
    notify();
    notify();
    await vi.advanceTimersByTimeAsync(249);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith("/sql");
  });
  it("queues a notification arriving while the previous refresh is running", async () => {
    let finish!: () => void;
    const changed = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValue(undefined);
    const { notify } = await mount(changed);
    notify();
    await vi.advanceTimersByTimeAsync(250);
    notify();
    await vi.advanceTimersByTimeAsync(250);
    expect(changed).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("releases removed roots and ignores callbacks from their old subscriptions", async () => {
    const stop = vi.fn(async () => {});
    mocks.watch.mockResolvedValueOnce(stop);
    const { notify, paths, changed } = await mount();
    paths.value = [{ path: "/other", recursive: true }];
    await nextTick();
    expect(stop).toHaveBeenCalledOnce();
    notify();
    await vi.advanceTimersByTimeAsync(250);
    expect(changed).not.toHaveBeenCalled();
    expect(mocks.watch).toHaveBeenLastCalledWith("/other", true, expect.any(Function));
  });
  it("cancels pending refreshes and closes native resources on disposal", async () => {
    const stop = vi.fn(async () => {});
    mocks.watch.mockResolvedValueOnce(stop);
    const { notify, scope, changed } = await mount();
    notify();
    scope.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(stop).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
  it("closes a resource registered after the owning scope was disposed", async () => {
    let registered!: (stop: () => Promise<void>) => void;
    mocks.watch.mockImplementationOnce(() => new Promise((resolve) => (registered = resolve)));
    const { scope } = await mount();
    scope.stop();
    const stop = vi.fn(async () => {});
    registered(stop);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });
});
