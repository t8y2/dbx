import { beforeEach, describe, expect, it } from "vitest";
import { isSavedSqlFileSearchVisible, isSavedSqlFolderSearchVisible, nearestLockedFolder } from "@/lib/sidebar/savedSqlFolderSearch";
import type { SavedSqlFolder } from "@/types/database";

function folder(id: string, options: { parentFolderId?: string; hasPassword?: boolean } = {}): SavedSqlFolder {
  return {
    id,
    connectionId: "conn",
    name: id,
    orderIndex: 0,
    createdAt: "",
    updatedAt: "",
    ...(options.parentFolderId ? { parentFolderId: options.parentFolderId } : {}),
    ...(options.hasPassword ? { hasPassword: true } : {}),
  };
}

describe("nearestLockedFolder", () => {
  const lockedFolderIds = new Set(["locked"]);
  const isFolderLocked = (candidate: SavedSqlFolder) => lockedFolderIds.has(candidate.id);

  it("returns null when the file has no folder", () => {
    const folders = [folder("locked")];
    expect(nearestLockedFolder(undefined, folders, isFolderLocked)).toBeNull();
  });

  it("returns the folder itself when it is locked", () => {
    const folders = [folder("locked")];
    expect(nearestLockedFolder("locked", folders, isFolderLocked)?.id).toBe("locked");
  });

  it("returns the nearest locked ancestor across levels", () => {
    const folders = [folder("locked"), folder("child", { parentFolderId: "locked" }), folder("grandchild", { parentFolderId: "child" })];
    expect(nearestLockedFolder("grandchild", folders, isFolderLocked)?.id).toBe("locked");
  });

  it("returns null when no folder in the chain is locked", () => {
    const folders = [folder("open")];
    expect(nearestLockedFolder("open", folders, isFolderLocked)).toBeNull();
  });

  it("unhides a protected branch once the session lock predicate clears", () => {
    // 搜索过滤与会话解锁共用同一语义:未解锁时锁定,解锁后(谓词返回 false)恢复可见。
    const folders = [folder("vault", { hasPassword: true }), folder("child", { parentFolderId: "vault" })];
    const unlocked = new Set<string>();
    const isFolderLockedBySession = (candidate: SavedSqlFolder) => !!candidate.hasPassword && !unlocked.has(candidate.id);

    expect(nearestLockedFolder("child", folders, isFolderLockedBySession)?.id).toBe("vault");
    unlocked.add("vault");
    expect(nearestLockedFolder("child", folders, isFolderLockedBySession)).toBeNull();
    // 文件夹自身未解锁时也被视为锁定,解锁后同样放行。
    expect(isFolderLockedBySession(folders[0])).toBe(false);
  });

  it("returns null on a broken or cyclic chain instead of looping forever", () => {
    const folders = [folder("orphan", { parentFolderId: "missing" }), folder("a", { parentFolderId: "b" }), folder("b", { parentFolderId: "a" })];
    expect(nearestLockedFolder("orphan", folders, isFolderLocked)).toBeNull();
    expect(nearestLockedFolder("a", folders, isFolderLocked)).toBeNull();
  });
});

describe("search opacity for locked branches", () => {
  const unlocked = new Set<string>();
  const isFolderLockedBySession = (candidate: SavedSqlFolder) => !!candidate.hasPassword && !unlocked.has(candidate.id);

  beforeEach(() => {
    unlocked.clear();
  });

  it("keeps a locked folder, its descendants and its files out of search results", () => {
    const folders = [folder("open"), folder("vault", { hasPassword: true }), folder("child", { parentFolderId: "vault" })];

    // A locked folder whose name matches the query must not surface...
    expect(isSavedSqlFolderSearchVisible(true, "vault", folders, isFolderLockedBySession)).toBe(false);
    // ...nor may any descendant branch or file inside the locked branch.
    expect(isSavedSqlFolderSearchVisible(true, "child", folders, isFolderLockedBySession)).toBe(false);
    expect(isSavedSqlFileSearchVisible(true, "child", folders, isFolderLockedBySession)).toBe(false);
    expect(isSavedSqlFileSearchVisible(true, "vault", folders, isFolderLockedBySession)).toBe(false);

    // Unprotected branches and unfiled files stay searchable.
    expect(isSavedSqlFolderSearchVisible(true, "open", folders, isFolderLockedBySession)).toBe(true);
    expect(isSavedSqlFileSearchVisible(true, undefined, folders, isFolderLockedBySession)).toBe(true);
  });

  it("restores search visibility after an in-session unlock", () => {
    const folders = [folder("vault", { hasPassword: true }), folder("child", { parentFolderId: "vault" })];
    unlocked.add("vault");

    expect(isSavedSqlFolderSearchVisible(true, "vault", folders, isFolderLockedBySession)).toBe(true);
    expect(isSavedSqlFolderSearchVisible(true, "child", folders, isFolderLockedBySession)).toBe(true);
    expect(isSavedSqlFileSearchVisible(true, "child", folders, isFolderLockedBySession)).toBe(true);
  });

  it("never filters when the protection feature is inactive (desktop)", () => {
    const folders = [folder("vault", { hasPassword: true }), folder("child", { parentFolderId: "vault" })];

    expect(isSavedSqlFolderSearchVisible(false, "vault", folders, isFolderLockedBySession)).toBe(true);
    expect(isSavedSqlFileSearchVisible(false, "vault", folders, isFolderLockedBySession)).toBe(true);
  });
});
