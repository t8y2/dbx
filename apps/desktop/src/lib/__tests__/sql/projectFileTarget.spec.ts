import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { findProjectForFilePath, resolveProjectFileTarget, type ResolveProjectFileTargetOptions } from "@/lib/sql/projectFileTarget";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

beforeEach(() => {
  installLocalStorage();
  // 路径大小写不敏感匹配依赖 isWindows()（读取 navigator.userAgent），
  // node 测试环境默认没有浏览器 UA，统一模拟 Windows 平台。
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
});
afterEach(() => vi.unstubAllGlobals());

function baseOptions(overrides: Partial<ResolveProjectFileTargetOptions> = {}): ResolveProjectFileTargetOptions {
  return {
    connectionExists: (id) => id !== "deleted-conn",
    getConnection: (id) => (id === "bound-conn" ? ({ database: "SPDB", db_type: "db2" } as any) : id === "active-conn" ? ({ database: "ACTIVE_DB" } as any) : id === "first-conn" ? ({ database: "FIRST_DB" } as any) : undefined),
    projects: [
      { id: "p1", rootPath: "/work/sp", connectionId: "bound-conn", defaultSchema: "DBO" },
      { id: "p2", rootPath: "/work/unbound", connectionId: null, defaultSchema: null },
    ],
    activeConnectionId: "active-conn",
    firstConnectionId: "first-conn",
    ...overrides,
  };
}

describe("resolveProjectFileTarget", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("项目绑定连接 + defaultSchema 覆盖 localStorage 每文件历史 target", () => {
    localStorage.setItem("dbx-external-sql-file-targets-v1", JSON.stringify([{ path: "/work/sp/proc.sql", connectionId: "active-conn", database: "STALE", updatedAt: Date.now() }]));
    const target = resolveProjectFileTarget("/work/sp/proc.sql", baseOptions());
    expect(target).toEqual({
      connectionId: "bound-conn",
      database: "SPDB",
      schema: "DBO",
      projectId: "p1",
    });
  });

  it("绑定连接存在但 defaultSchema 为空 → schema 为 undefined", () => {
    const options = baseOptions({
      projects: [{ id: "p1", rootPath: "/work/sp", connectionId: "bound-conn", defaultSchema: null }],
    });
    const target = resolveProjectFileTarget("/work/sp/proc.sql", options);
    expect(target.schema).toBeUndefined();
    expect(target.connectionId).toBe("bound-conn");
  });

  it("绑定连接已失效 → 回退每文件历史 target", () => {
    localStorage.setItem("dbx-external-sql-file-targets-v1", JSON.stringify([{ path: "/work/sp/proc.sql", connectionId: "active-conn", database: "HIST_DB", updatedAt: Date.now() }]));
    const options = baseOptions({ projects: [{ id: "p1", rootPath: "/work/sp", connectionId: "deleted-conn", defaultSchema: null }] });
    const target = resolveProjectFileTarget("/work/sp/proc.sql", options);
    expect(target.connectionId).toBe("active-conn");
    expect(target.database).toBe("HIST_DB");
    expect(target.projectId).toBe("p1");
  });

  it("项目未绑定连接 → 每文件历史 target → active → first 逐级回退", () => {
    const options = baseOptions({ projects: [{ id: "p2", rootPath: "/work/unbound", connectionId: null, defaultSchema: null }] });
    const target = resolveProjectFileTarget("/work/unbound/proc.sql", options);
    expect(target.connectionId).toBe("active-conn");
    expect(target.database).toBe("ACTIVE_DB");
    expect(target.projectId).toBe("p2");
  });

  it("无项目归属 → 与旧逻辑一致（历史 target 优先，catalog 透传）", () => {
    localStorage.setItem("dbx-external-sql-file-targets-v1", JSON.stringify([{ path: "/work/report.sql", connectionId: "active-conn", database: "HIST_DB", catalog: "hive", updatedAt: Date.now() }]));
    const target = resolveProjectFileTarget("/work/report.sql", baseOptions({ projects: [] }));
    expect(target).toEqual({ connectionId: "active-conn", database: "HIST_DB", catalog: "hive", projectId: undefined });
  });

  it("无项目归属且无历史 target → active/first 回退", () => {
    const target = resolveProjectFileTarget("/work/report.sql", baseOptions({ projects: [] }));
    expect(target.connectionId).toBe("active-conn");
    expect(target.database).toBe("ACTIVE_DB");
  });

  it("active 与 first 均为空 → 返回空 connectionId，不抛异常", () => {
    const target = resolveProjectFileTarget("/work/report.sql", baseOptions({ activeConnectionId: null, firstConnectionId: undefined, projects: [] }));
    expect(target).toEqual({ connectionId: "", database: "", projectId: undefined });
  });

  it("嵌套项目：文件命中最长根前缀的子项目绑定", () => {
    const options = baseOptions({
      projects: [
        { id: "parent", rootPath: "/work", connectionId: "active-conn", defaultSchema: null },
        { id: "child", rootPath: "/work/sp", connectionId: "bound-conn", defaultSchema: "CHILD_SCHEMA" },
      ],
    });
    const target = resolveProjectFileTarget("/work/sp/proc.sql", options);
    expect(target.projectId).toBe("child");
    expect(target.connectionId).toBe("bound-conn");
    expect(target.schema).toBe("CHILD_SCHEMA");
  });

  it("根目录尾分隔符/Windows 盘符大小写不影响前缀匹配", () => {
    const options = baseOptions({
      projects: [{ id: "p1", rootPath: "C:\\Work\\SP\\", connectionId: "bound-conn", defaultSchema: "DBO" }],
    });
    const target = resolveProjectFileTarget("c:/work/sp/proc.sql", options);
    expect(target.projectId).toBe("p1");
  });
});

describe("findProjectForFilePath", () => {
  it("返回最长根前缀匹配的项目", () => {
    const projects = [
      { id: "a", rootPath: "/work", connectionId: null, defaultSchema: null },
      { id: "b", rootPath: "/work/sp", connectionId: null, defaultSchema: null },
    ];
    expect(findProjectForFilePath(projects, "/work/sp/deep/proc.sql")?.id).toBe("b");
    expect(findProjectForFilePath(projects, "/work/other.sql")?.id).toBe("a");
    expect(findProjectForFilePath(projects, "/elsewhere/proc.sql")).toBeNull();
  });

  it("根目录本身不等于前缀（/ab 不匹配 /a 目录）", () => {
    const projects = [{ id: "a", rootPath: "/a", connectionId: null, defaultSchema: null }];
    expect(findProjectForFilePath(projects, "/ab/proc.sql")).toBeNull();
    expect(findProjectForFilePath(projects, "/a/proc.sql")?.id).toBe("a");
  });
});
