import { defineStore } from "pinia";
import { computed, ref } from "vue";
import * as api from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isWindows } from "@/lib/backend/platform";
import { getSqlFileFolderPaths, saveSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";
import type { SqlProject } from "@/lib/backend/tauri";

/** UI 状态（激活项目等）持久化 key。 */
const UI_STORAGE_KEY = "dbx-sql-project-ui";

function desktopOnly(): void {
  if (!isTauriRuntime()) {
    throw new Error("SQL projects are only available in the desktop app");
  }
}

function compareRecentFirst(a: SqlProject, b: SqlProject): number {
  return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
}

function normalizeRootForCompare(path: string): string {
  let normalized = path.trim().replace(/\//g, "\\");
  if (isWindows()) {
    normalized = normalized.toLowerCase();
  }
  while (normalized.endsWith("\\") && normalized.length > 3) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export const useProjectStore = defineStore("sqlProject", () => {
  /** 全部项目，按最近打开排序（最近在前）。 */
  const projects = ref<SqlProject[]>([]);
  const loaded = ref(false);
  /** 激活项目：决定连接注入与 QuickOpen 优先源。 */
  const activeProjectId = ref<string | null>(null);
  /** 新建后尚未配置（绑定连接）的项目 id，供 UI 弹项目设置对话框。 */
  const pendingSettingsProjectId = ref<string | null>(null);

  const activeProject = computed<SqlProject | null>(() => {
    return projects.value.find((project) => project.id === activeProjectId.value) ?? null;
  });

  function persistUiState(): void {
    try {
      safeLocalStorageSet(UI_STORAGE_KEY, JSON.stringify({ activeProjectId: activeProjectId.value }));
    } catch {
      // ignore storage errors
    }
  }

  function restoreUiState(): void {
    let restoredId: string | null = null;
    try {
      const raw = safeLocalStorageGet(UI_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.activeProjectId === "string") {
          restoredId = parsed.activeProjectId;
        }
      }
    } catch {
      restoredId = null;
    }
    if (restoredId && projects.value.some((project) => project.id === restoredId)) {
      activeProjectId.value = restoredId;
      return;
    }
    if (!activeProjectId.value && projects.value.length > 0) {
      activeProjectId.value = projects.value[0].id;
    }
  }

  function replaceOrInsertProject(project: SqlProject): void {
    const index = projects.value.findIndex((item) => item.id === project.id);
    if (index >= 0) {
      projects.value[index] = project;
    } else {
      projects.value.push(project);
    }
    projects.value.sort(compareRecentFirst);
  }

  /**
   * 老用户平滑升级：把 localStorage `dbx-sql-file-folders` 中已添加的文件夹
   * 一次性迁移为 dbx.db 中的项目记录（connection 留空，trusted=true——
   * 老用户已手动添加过，视为已信任），迁移后清空旧列表。
   * 返回是否发生了迁移。
   */
  async function migrateLegacyFolders(): Promise<boolean> {
    const legacyPaths = getSqlFileFolderPaths();
    if (legacyPaths.length === 0) return false;

    const knownIds = new Set(projects.value.map((project) => project.id));
    const knownRoots = new Set(projects.value.map((project) => normalizeRootForCompare(project.rootPath)));
    let changed = false;

    for (const path of legacyPaths) {
      if (knownRoots.has(normalizeRootForCompare(path))) continue;
      try {
        const project = await api.openSqlProjectByPath(path);
        knownRoots.add(normalizeRootForCompare(project.rootPath));
        if (knownIds.has(project.id)) continue;
        knownIds.add(project.id);
        const trustedProject = project.trusted ? project : await api.trustSqlProject(project.id);
        projects.value.push(trustedProject);
        changed = true;
      } catch {
        // 目录已不存在等场景：跳过该遗留文件夹
      }
    }

    // 废弃旧列表；bump 版本号通知订阅者（QuickOpen 等）。
    saveSqlFileFolderPaths([]);
    if (changed) projects.value.sort(compareRecentFirst);
    return changed;
  }

  /** 加载项目列表（含遗留文件夹迁移与 UI 状态恢复）。 */
  async function loadProjects(options: { force?: boolean } = {}): Promise<void> {
    if (!isTauriRuntime()) {
      loaded.value = true;
      return;
    }
    if (loaded.value && !options.force) return;
    const list = await api.listSqlProjects();
    projects.value = [...list].sort(compareRecentFirst);
    await migrateLegacyFolders();
    restoreUiState();
    loaded.value = true;
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await loadProjects();
  }

  function setActiveProject(id: string | null): void {
    activeProjectId.value = id;
    persistUiState();
  }

  /**
   * 三条入口（OS 拖放/命令行、窗口内拖放、菜单选择）的统一汇聚点。
   * 已存在项目则激活并更新 last_opened_at；不存在则创建（trusted=false）
   * 并标记 pendingSettingsProjectId，由 UI 弹项目设置对话框绑定连接。
   */
  async function openProjectByPath(rootPath: string, options: { activate?: boolean } = {}): Promise<SqlProject> {
    desktopOnly();
    await ensureLoaded();
    const activate = options.activate ?? true;
    const knownIds = new Set(projects.value.map((project) => project.id));
    const project = await api.openSqlProjectByPath(rootPath);
    replaceOrInsertProject(project);
    if (!knownIds.has(project.id)) {
      pendingSettingsProjectId.value = project.id;
    }
    if (activate) {
      setActiveProject(project.id);
    }
    return project;
  }

  /** 多目录打开：第一个为激活项目，其余仅加入项目列表。 */
  async function openProjects(rootPaths: string[]): Promise<SqlProject[]> {
    const opened: SqlProject[] = [];
    let first = true;
    for (const rootPath of rootPaths) {
      try {
        opened.push(await openProjectByPath(rootPath, { activate: first }));
        first = false;
      } catch {
        // 单个目录打开失败不影响其余目录
      }
    }
    return opened;
  }

  /** 项目设置保存（名称/绑定连接/默认 schema）。 */
  async function updateProject(project: SqlProject): Promise<SqlProject> {
    desktopOnly();
    const updated = await api.updateSqlProject(project.id, project.name, project.connectionId, project.defaultSchema);
    replaceOrInsertProject(updated);
    if (pendingSettingsProjectId.value === updated.id) {
      pendingSettingsProjectId.value = null;
    }
    return updated;
  }

  /** 信任确认：首次打开未信任项目，用户确认后持久化（仅后端设置 trusted）。 */
  async function markTrusted(project: SqlProject): Promise<SqlProject> {
    desktopOnly();
    const updated = await api.trustSqlProject(project.id);
    replaceOrInsertProject(updated);
    return updated;
  }

  /** 移除项目记录（不删除磁盘文件）；快照随项目一并清理。 */
  async function removeProject(id: string): Promise<void> {
    desktopOnly();
    await api.deleteSqlProject(id);
    projects.value = projects.value.filter((project) => project.id !== id);
    if (pendingSettingsProjectId.value === id) {
      pendingSettingsProjectId.value = null;
    }
    if (activeProjectId.value === id) {
      setActiveProject(projects.value[0]?.id ?? null);
    }
  }

  /** 按根目录找项目（大小写不敏感，Windows 盘符大小写差异安全）。 */
  function projectByRootPath(rootPath: string): SqlProject | null {
    const target = normalizeRootForCompare(rootPath);
    return projects.value.find((project) => normalizeRootForCompare(project.rootPath) === target) ?? null;
  }

  /** 按文件绝对路径找所属项目（最长根前缀匹配）。 */
  function projectForFilePath(filePath: string): SqlProject | null {
    const normalized = filePath.replace(/\//g, "\\");
    const cmp = isWindows() ? normalized.toLowerCase() : normalized;
    let best: SqlProject | null = null;
    for (const project of projects.value) {
      let root = project.rootPath.replace(/\//g, "\\");
      if (isWindows()) root = root.toLowerCase();
      if (!root.endsWith("\\")) root += "\\";
      if (cmp.startsWith(root) && (!best || project.rootPath.length > best.rootPath.length)) {
        best = project;
      }
    }
    return best;
  }

  /** 取出并清空"待弹设置对话框"的项目。 */
  function takePendingSettingsProject(): SqlProject | null {
    if (!pendingSettingsProjectId.value) return null;
    const project = projects.value.find((item) => item.id === pendingSettingsProjectId.value) ?? null;
    pendingSettingsProjectId.value = null;
    return project;
  }

  return {
    projects,
    loaded,
    activeProjectId,
    pendingSettingsProjectId,
    activeProject,
    loadProjects,
    ensureLoaded,
    openProjectByPath,
    openProjects,
    updateProject,
    markTrusted,
    removeProject,
    setActiveProject,
    projectByRootPath,
    projectForFilePath,
    takePendingSettingsProject,
  };
});
