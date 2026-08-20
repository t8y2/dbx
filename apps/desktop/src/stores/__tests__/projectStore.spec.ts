import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as api from "@/lib/backend/api";
import { useProjectStore } from "@/stores/projectStore";
import type { SqlProject } from "@/lib/backend/tauri";

vi.mock("@/lib/backend/api", () => ({
  listSqlProjects: vi.fn(),
  openSqlProjectByPath: vi.fn(),
  trustSqlProject: vi.fn(),
}));

const STORAGE_KEY = "dbx-sql-file-folders";

function installMemoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

function legacyPaths(): string[] {
  const raw = (globalThis.localStorage as Storage).getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function project(id: string, rootPath: string): SqlProject {
  return {
    id,
    name: rootPath.split(/[/\\]/).pop() || id,
    rootPath,
    connectionId: null,
    defaultSchema: null,
    trusted: false,
    rootIdentity: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
}

const mockApi = api as {
  listSqlProjects: ReturnType<typeof vi.fn>;
  openSqlProjectByPath: ReturnType<typeof vi.fn>;
  trustSqlProject: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  installMemoryStorage();
  // isTauriRuntime() 依赖 __TAURI_INTERNALS__，node 环境需要模拟。
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  // isWindows() 依赖 navigator.userAgent。
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  mockApi.listSqlProjects.mockReset();
  mockApi.openSqlProjectByPath.mockReset();
  mockApi.trustSqlProject.mockReset();
  mockApi.listSqlProjects.mockResolvedValue([]);
  // trust 成功时后端返回 trusted=true 的项目对象。
  mockApi.trustSqlProject.mockImplementation(async (id: string) => ({ ...project(id, "/work"), trusted: true }));
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migrateLegacyFolders", () => {
  it("全部迁移成功 → 旧列表清空", async () => {
    (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(["/work/sp", "/work/legacy"]));
    mockApi.openSqlProjectByPath.mockImplementation(async (path: string) => (path === "/work/sp" ? project("p1", "/work/sp") : project("p2", "/work/legacy")));

    const store = useProjectStore();
    await store.loadProjects();

    expect(legacyPaths()).toEqual([]);
    expect(store.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("部分失败 → 失败项保留，成功项移除", async () => {
    (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(["/work/ok", "/work/missing", "/work/ok2"]));
    mockApi.openSqlProjectByPath.mockImplementation(async (path: string) => {
      if (path === "/work/missing") throw new Error("not found");
      return project(path === "/work/ok" ? "p1" : "p2", path);
    });

    const store = useProjectStore();
    await store.loadProjects();

    expect(legacyPaths()).toEqual(["/work/missing"]);
    expect(store.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("全部失败 → 旧列表原样保留", async () => {
    const paths = ["/work/a", "/work/b"];
    (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(paths));
    mockApi.openSqlProjectByPath.mockRejectedValue(new Error("not found"));

    const store = useProjectStore();
    await store.loadProjects();

    expect(legacyPaths()).toEqual(paths);
    expect(store.projects).toEqual([]);
  });

  it("openSqlProjectByPath 成功但 trustSqlProject 失败 → 该项保留重试", async () => {
    (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(["/work/tmp"]));
    mockApi.openSqlProjectByPath.mockResolvedValue(project("p1", "/work/tmp"));
    mockApi.trustSqlProject.mockRejectedValue(new Error("trust failed"));

    const store = useProjectStore();
    await store.loadProjects();

    expect(legacyPaths()).toEqual(["/work/tmp"]);
    expect(store.projects).toEqual([]);
  });

  it("已存在项目的路径视为成功（不调用 api，且从旧列表移除）", async () => {
    (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(["/work/sp", "/work/new"]));
    mockApi.listSqlProjects.mockResolvedValue([project("existing", "/work/sp")]);
    mockApi.openSqlProjectByPath.mockResolvedValue(project("new-p", "/work/new"));

    const store = useProjectStore();
    await store.loadProjects();

    expect(mockApi.openSqlProjectByPath).toHaveBeenCalledTimes(1);
    expect(mockApi.openSqlProjectByPath).toHaveBeenCalledWith("/work/new");
    expect(legacyPaths()).toEqual([]);
    expect(store.projects.map((p) => p.id).sort()).toEqual(["existing", "new-p"]);
  });

  it("空列表 → no-op 不写 storage", async () => {
    const store = useProjectStore();
    await store.loadProjects();
    expect(legacyPaths()).toEqual([]);
    expect(mockApi.openSqlProjectByPath).not.toHaveBeenCalled();
    expect(store.projects).toEqual([]);
  });
});
