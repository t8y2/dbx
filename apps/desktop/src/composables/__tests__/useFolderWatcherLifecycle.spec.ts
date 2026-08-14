// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";
import { useFolderWatcherLifecycle } from "@/composables/useFolderWatcherLifecycle";

function createMocks() {
  const ensureWatcher = vi.fn<(path: string) => Promise<() => void>>();
  const rescan = vi.fn<(path: string) => void>();
  const handles: Array<ReturnType<typeof vi.fn>> = [];
  // 每次调用返回一个独立 handle，便于断言哪个 watcher 被拆除。
  ensureWatcher.mockImplementation(async () => {
    const handle = vi.fn();
    handles.push(handle);
    return handle;
  });
  return { ensureWatcher, rescan, handles };
}

/** 手动控制 resolve 时机的 Promise，用于模拟异步 watcher 创建。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 冲掉 startWatcher 中 await ensureWatcher 产生的微任务。 */
async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

function createLifecycle(activeFolderPath: Ref<string | null>, mocks: ReturnType<typeof createMocks>, enabled = true) {
  return useFolderWatcherLifecycle({
    activeFolderPath,
    ensureWatcher: mocks.ensureWatcher,
    rescan: mocks.rescan,
    isEnabled: () => enabled,
  });
}

describe("useFolderWatcherLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- 规则 1：仅激活项目创建 watcher ----

  it("init creates watcher only for the active project", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/active");
  });

  it("init does not create watcher when no active project", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>(null);
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    expect(mocks.ensureWatcher).not.toHaveBeenCalled();
  });

  it("init does not create watcher when disabled (non-Tauri)", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks, false);

    lifecycle.init();

    expect(mocks.ensureWatcher).not.toHaveBeenCalled();
  });

  // ---- 规则 2：切换项目时旧 watcher 拆除、新 watcher 创建 ----

  it("switching active project drops old watcher and creates new one", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");

    // 切换到项目 B
    activePath.value = "/projects/B";
    await nextTick();
    await flushAsync();

    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/B");
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(2);
    // 旧 watcher handle 应被拆除
    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
  });

  it("switching to same project does not recreate watcher", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();

    // 设置为相同值（不触发 watch）
    activePath.value = "/projects/A";
    await nextTick();

    expect(mocks.handles[0]).not.toHaveBeenCalled();
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(1);
  });

  it("switching from project to null drops watcher without creating new one", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();

    activePath.value = null;
    await nextTick();

    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(1);
  });

  it("switching from null to project creates watcher without dropping", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>(null);
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    expect(mocks.ensureWatcher).not.toHaveBeenCalled();

    activePath.value = "/projects/A";
    await nextTick();
    await flushAsync();

    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");
    expect(mocks.handles[0]).not.toHaveBeenCalled();
  });

  // ---- 规则 3：窗口聚焦仅重扫激活项目 ----

  it("handleFocus rescans only the active project", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.handleFocus();

    expect(mocks.rescan).toHaveBeenCalledTimes(1);
    expect(mocks.rescan).toHaveBeenCalledWith("/projects/active");
  });

  it("handleFocus does nothing when no active project", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>(null);
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.handleFocus();

    expect(mocks.rescan).not.toHaveBeenCalled();
  });

  it("handleFocus does nothing when disabled", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks, false);

    lifecycle.handleFocus();

    expect(mocks.rescan).not.toHaveBeenCalled();
  });

  it("handleFocus after switching project rescans the new active project", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    activePath.value = "/projects/B";
    await nextTick();

    lifecycle.handleFocus();

    expect(mocks.rescan).toHaveBeenCalledWith("/projects/B");
    expect(mocks.rescan).not.toHaveBeenCalledWith("/projects/A");
  });

  // ---- 规则 4：清理时拆除当前 watcher ----

  it("cleanup drops the active watcher", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();
    lifecycle.cleanup();

    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
  });

  it("cleanup does nothing when no watcher exists", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>(null);
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.cleanup();

    expect(mocks.handles).toHaveLength(0);
  });

  it("cleanup after switch drops the new watcher not the old one", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();

    activePath.value = "/projects/B";
    await nextTick();
    await flushAsync();

    lifecycle.cleanup();

    // A 在切换时拆除，B 在 cleanup 时拆除
    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
    expect(mocks.handles[1]).toHaveBeenCalledTimes(1);
  });

  // ---- 多项目场景回归 ----

  it("multiple rapid switches correctly manage watcher lifecycle", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();

    activePath.value = "/projects/B";
    await nextTick();
    await flushAsync();
    activePath.value = "/projects/C";
    await nextTick();
    await flushAsync();
    activePath.value = "/projects/A";
    await nextTick();
    await flushAsync();

    // 应该有 4 次 ensureWatcher（init + 3 次切换）
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(4);
    // 前三个 watcher（A、B、C）都应在切换时被拆除
    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
    expect(mocks.handles[1]).toHaveBeenCalledTimes(1);
    expect(mocks.handles[2]).toHaveBeenCalledTimes(1);
    // 最终 watcher 应该在 A（未被拆除）
    expect(mocks.handles[3]).not.toHaveBeenCalled();

    lifecycle.cleanup();
    expect(mocks.handles[3]).toHaveBeenCalledTimes(1);
  });

  // ---- 竞态场景：切换发生在 ensureWatcher 完成前 ----

  it("rapid A→B→A switch does not leak watchers", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();
    // 快速切换 A→B→A，不等 ensureWatcher 完成
    activePath.value = "/projects/B";
    await nextTick();
    activePath.value = "/projects/A";
    await nextTick();
    await flushAsync();

    // A1、B 应被拆除，A2 保留
    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
    expect(mocks.handles[1]).toHaveBeenCalledTimes(1);
    expect(mocks.handles[2]).not.toHaveBeenCalled();

    lifecycle.cleanup();
    expect(mocks.handles[2]).toHaveBeenCalledTimes(1);
  });

  it("switching to null then back to a project does not leak", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    await flushAsync();
    activePath.value = null;
    await nextTick();
    activePath.value = "/projects/A";
    await nextTick();
    await flushAsync();

    // 应重新创建 A 的 watcher
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(2);
    expect(mocks.handles[0]).toHaveBeenCalledTimes(1);
    lifecycle.cleanup();
    expect(mocks.handles[1]).toHaveBeenCalledTimes(1);
  });

  // ---- deferred watcher 初始化：晚到的 handle 释放 ----

  it("releases late unwatch handle when project switches before watcher creation completes", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    // init 的 A watcher 创建挂起（不立即 resolve）
    const lateUnwatch = vi.fn();
    const late = deferred<() => void>();
    mocks.ensureWatcher.mockReturnValueOnce(late.promise);

    lifecycle.init();
    // A→B 切换，不等 A watcher 完成
    activePath.value = "/projects/B";
    await nextTick();

    // 晚到的 A watcher 现在才完成，handle 应被立即释放
    late.resolve(lateUnwatch);
    await flushAsync();

    expect(lateUnwatch).toHaveBeenCalledTimes(1);
  });

  it("keeps handle when no switch occurs before watcher creation completes", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    const handle = vi.fn();
    const pending = deferred<() => void>();
    mocks.ensureWatcher.mockReturnValueOnce(pending.promise);

    lifecycle.init();
    pending.resolve(handle);
    await flushAsync();

    // 没有切换，handle 不应被释放
    expect(handle).not.toHaveBeenCalled();
  });

  it("releases late handle across rapid A→B→A switch", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    const handleA1 = vi.fn();
    const handleB = vi.fn();
    const handleA2 = vi.fn();
    const dA1 = deferred<() => void>();
    const dB = deferred<() => void>();
    const dA2 = deferred<() => void>();

    mocks.ensureWatcher.mockReturnValueOnce(dA1.promise).mockReturnValueOnce(dB.promise).mockReturnValueOnce(dA2.promise);

    lifecycle.init(); // A watcher 挂起 (dA1)
    await nextTick();
    activePath.value = "/projects/B"; // B watcher 挂起 (dB)
    await nextTick();
    activePath.value = "/projects/A"; // A watcher 挂起 (dA2)
    await nextTick();

    // 三个 watcher 依次完成：前两个是晚到的，应被释放；最后一个保留
    dA1.resolve(handleA1);
    await flushAsync();
    dB.resolve(handleB);
    await flushAsync();
    dA2.resolve(handleA2);
    await flushAsync();

    expect(handleA1).toHaveBeenCalledTimes(1);
    expect(handleB).toHaveBeenCalledTimes(1);
    expect(handleA2).not.toHaveBeenCalled();
  });
});
