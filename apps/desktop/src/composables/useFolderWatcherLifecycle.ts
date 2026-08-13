import { ref, watch, type Ref } from "vue";

/**
 * 文件夹 watcher 生命周期管理。
 *
 * 核心规则：
 * 1. 仅激活项目创建 recursive watcher，非激活项目不 watch
 * 2. 切换激活项目时，旧 watcher 拆除、新 watcher 创建
 * 3. 窗口聚焦时仅重扫激活项目（非全项目）
 *
 * 使用方式：
 * ```ts
 * const lifecycle = useFolderWatcherLifecycle({
 *   activeFolderPath: computed(() => activeFolder.value?.path ?? null),
 *   ensureWatcher: (path) => ensureFolderWatcher(path),
 *   dropWatcher: (path) => dropFolderWatcher(path),
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
  /** 为指定路径创建 watcher */
  ensureWatcher: (path: string) => void;
  /** 拆除指定路径的 watcher */
  dropWatcher: (path: string) => void;
  /** 重扫指定路径（窗口聚焦时调用） */
  rescan: (path: string) => void;
  /** 是否可用（如 isTauriRuntime 检查） */
  isEnabled: () => boolean;
}

export function useFolderWatcherLifecycle(options: FolderWatcherLifecycleOptions) {
  const { activeFolderPath, ensureWatcher, dropWatcher, rescan, isEnabled } = options;
  const watchedPath = ref<string | null>(null);

  /** 初始化：为当前激活项目创建 watcher */
  function init() {
    if (!isEnabled()) return;
    if (activeFolderPath.value) {
      watchedPath.value = activeFolderPath.value;
      ensureWatcher(activeFolderPath.value);
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

  /** 清理：拆除所有 watcher */
  function cleanup() {
    if (watchedPath.value) {
      dropWatcher(watchedPath.value);
      watchedPath.value = null;
    }
  }

  // 监听激活项目变化，自动切换 watcher
  watch(activeFolderPath, (newPath, oldPath) => {
    if (!isEnabled()) return;
    if (oldPath && oldPath !== newPath) {
      dropWatcher(oldPath);
      watchedPath.value = null;
    }
    if (newPath && newPath !== oldPath) {
      watchedPath.value = newPath;
      ensureWatcher(newPath);
    }
  });

  return { init, handleFocus, cleanup, watchedPath };
}
