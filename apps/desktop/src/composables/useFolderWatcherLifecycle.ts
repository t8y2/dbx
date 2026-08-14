import { ref, watch, type Ref } from "vue";

/**
 * 文件夹 watcher 生命周期管理。
 *
 * 核心规则：
 * 1. 仅激活项目创建 watcher，非激活项目不 watch
 * 2. 切换激活项目时，旧 watcher 拆除、新 watcher 创建
 * 3. 窗口聚焦时仅重扫激活项目（非全项目）
 * 4. ensureWatcher 返回 unwatch handle；若激活项目在异步创建完成前切换，
 *    通过 generation 使晚到的 handle 立即释放，避免泄漏
 *
 * 取消机制单一化：watcher 的创建/拆除完全由本 composable 通过 handle 管理，
 * ensureWatcher 是无状态的（每次调用返回独立 handle），不在调用方维护按路径
 * 索引的 watcher map，从而避免两套"过期"判断互相冲突。
 *
 * 使用方式：
 * ```ts
 * const lifecycle = useFolderWatcherLifecycle({
 *   activeFolderPath: computed(() => activeFolder.value?.path ?? null),
 *   ensureWatcher: (path) => ensureFolderWatcher(path),
 *   rescan: (path) => loadFolderEntries(path, { silent: true }),
 * });
 * // onMounted 中调用 lifecycle.init()
 * // handleWindowFocus 中调用 lifecycle.handleFocus()
 * // onBeforeUnmount 中调用 lifecycle.cleanup()
 * ```
 */
export interface FolderWatcherLifecycleOptions {
  /** 当前激活项目的路径（null 表示无激活项目） */
  activeFolderPath: Ref<string | null>;
  /** 为指定路径创建 watcher，resolve 返回 unwatch handle（创建失败 resolve no-op） */
  ensureWatcher: (path: string) => Promise<() => void>;
  /** 重扫指定路径（窗口聚焦时调用） */
  rescan: (path: string) => void;
  /** 是否可用（如 isTauriRuntime 检查） */
  isEnabled: () => boolean;
}

export function useFolderWatcherLifecycle(options: FolderWatcherLifecycleOptions) {
  const { activeFolderPath, ensureWatcher, rescan, isEnabled } = options;
  const watchedPath = ref<string | null>(null);

  // generation 递增表示"激活项目已变化"；晚到的异步 handle 据此立即释放。
  let generation = 0;
  let currentUnwatch: (() => void) | null = null;

  async function startWatcher(path: string): Promise<void> {
    const gen = generation;
    watchedPath.value = path;
    let unwatch: () => void;
    try {
      unwatch = await ensureWatcher(path);
    } catch {
      // 创建失败：退回"窗口聚焦刷新"
      return;
    }
    // 异步创建完成时激活项目已切换：晚到的 handle 立即释放，避免泄漏。
    if (gen !== generation) {
      try {
        unwatch();
      } catch {
        /* ignore */
      }
      return;
    }
    currentUnwatch = unwatch;
  }

  function stopCurrentWatcher() {
    if (!currentUnwatch) return;
    try {
      currentUnwatch();
    } catch {
      /* ignore */
    }
    currentUnwatch = null;
  }

  /** 初始化：为当前激活项目创建 watcher */
  function init() {
    if (!isEnabled()) return;
    if (activeFolderPath.value) {
      void startWatcher(activeFolderPath.value);
    }
  }

  /**
   * 窗口聚焦处理：仅重扫激活项目。
   * 旧实现会 Promise.all(folders.value.map(...)) 重扫所有项目，
   * 新实现仅扫描 activeFolderPath 对应的项目。
   */
  function handleFocus() {
    if (!isEnabled() || !activeFolderPath.value) return;
    rescan(activeFolderPath.value);
  }

  /** 清理：使进行中的 watcher 失效并拆除当前 watcher */
  function cleanup() {
    generation++;
    stopCurrentWatcher();
    watchedPath.value = null;
  }

  // 监听激活项目变化，自动切换 watcher
  watch(activeFolderPath, (newPath, oldPath) => {
    if (!isEnabled()) return;
    if (oldPath && oldPath !== newPath) {
      generation++;
      stopCurrentWatcher();
    }
    if (newPath && newPath !== oldPath) {
      void startWatcher(newPath);
    } else if (!newPath) {
      watchedPath.value = null;
    }
  });

  return { init, handleFocus, cleanup, watchedPath };
}
