// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";
import { useFolderWatcherLifecycle } from "@/composables/useFolderWatcherLifecycle";

function createMocks() {
  const ensureWatcher = vi.fn();
  const dropWatcher = vi.fn();
  const rescan = vi.fn();
  return { ensureWatcher, dropWatcher, rescan };
}

function createLifecycle(activeFolderPath: Ref<string | null>, mocks: ReturnType<typeof createMocks>, enabled = true) {
  return useFolderWatcherLifecycle({
    activeFolderPath,
    ensureWatcher: mocks.ensureWatcher,
    dropWatcher: mocks.dropWatcher,
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
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");

    // 切换到项目 B
    activePath.value = "/projects/B";
    await nextTick();

    expect(mocks.dropWatcher).toHaveBeenCalledWith("/projects/A");
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/B");
    expect(mocks.dropWatcher).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(2);
  });

  it("switching to same project does not recreate watcher", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    // 设置为相同值（不触发 watch）
    activePath.value = "/projects/A";
    await nextTick();

    expect(mocks.dropWatcher).not.toHaveBeenCalled();
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(1);
  });

  it("switching from project to null drops watcher without creating new one", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    activePath.value = null;
    await nextTick();

    expect(mocks.dropWatcher).toHaveBeenCalledWith("/projects/A");
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

    expect(mocks.dropWatcher).not.toHaveBeenCalled();
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");
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

  // ---- 规则 4：清理时拆除所有 watcher ----

  it("cleanup drops the active watcher", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/active");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    lifecycle.cleanup();

    expect(mocks.dropWatcher).toHaveBeenCalledWith("/projects/active");
  });

  it("cleanup does nothing when no watcher exists", () => {
    const mocks = createMocks();
    const activePath = ref<string | null>(null);
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.cleanup();

    expect(mocks.dropWatcher).not.toHaveBeenCalled();
  });

  it("cleanup after switch drops the new watcher not the old one", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    activePath.value = "/projects/B";
    await nextTick();

    lifecycle.cleanup();

    // cleanup 应该拆除 B（当前 watcher），A 已在切换时拆除
    expect(mocks.dropWatcher).toHaveBeenCalledWith("/projects/A");
    expect(mocks.dropWatcher).toHaveBeenCalledWith("/projects/B");
  });

  // ---- 多项目场景回归 ----

  it("multiple rapid switches correctly manage watcher lifecycle", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();

    activePath.value = "/projects/B";
    await nextTick();
    activePath.value = "/projects/C";
    await nextTick();
    activePath.value = "/projects/A";
    await nextTick();

    // 应该有 4 次 ensureWatcher（init + 3 次切换）
    expect(mocks.ensureWatcher).toHaveBeenCalledTimes(4);
    // 应该有 3 次 dropWatcher（A→B, B→C, C→A）
    expect(mocks.dropWatcher).toHaveBeenCalledTimes(3);

    // 最终 watcher 应该在 A
    lifecycle.cleanup();
    expect(mocks.dropWatcher).toHaveBeenLastCalledWith("/projects/A");
  });

  // ---- 竞态场景：切换发生在 ensureWatcher 完成前 ----

  it("rapid A→B→A switch does not leak watchers", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    // 快速切换 A→B→A，不等 ensureWatcher 完成
    activePath.value = "/projects/B";
    activePath.value = "/projects/A";
    await nextTick();

    // 最终应只剩 A 的 watcher
    lifecycle.cleanup();
    // dropWatcher 应被调用（至少拆除最终 watcher）
    expect(mocks.dropWatcher).toHaveBeenCalled();
    // 最后一次 cleanup 拆除的应该是 A
    expect(mocks.dropWatcher).toHaveBeenLastCalledWith("/projects/A");
  });

  it("switching to null then back to a project does not leak", async () => {
    const mocks = createMocks();
    const activePath = ref<string | null>("/projects/A");
    const lifecycle = createLifecycle(activePath, mocks);

    lifecycle.init();
    activePath.value = null;
    await nextTick();
    activePath.value = "/projects/A";
    await nextTick();

    // 应重新创建 A 的 watcher
    expect(mocks.ensureWatcher).toHaveBeenCalledWith("/projects/A");
    lifecycle.cleanup();
    expect(mocks.dropWatcher).toHaveBeenLastCalledWith("/projects/A");
  });
});
