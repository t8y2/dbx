import { describe, expect, it } from "vitest";
import { nearestLockedFolder } from "@/lib/sidebar/savedSqlFolderSearch";
import type { SavedSqlFolder } from "@/types/database";

function folder(id: string, options: { parentFolderId?: string; passwordHash?: string } = {}): SavedSqlFolder {
  return {
    id,
    connectionId: "conn",
    name: id,
    orderIndex: 0,
    createdAt: "",
    updatedAt: "",
    ...(options.parentFolderId ? { parentFolderId: options.parentFolderId } : {}),
    ...(options.passwordHash ? { passwordHash: options.passwordHash } : {}),
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
    const folders = [folder("vault", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" }), folder("child", { parentFolderId: "vault" })];
    const unlocked = new Set<string>();
    const isFolderLockedBySession = (candidate: SavedSqlFolder) => !!candidate.passwordHash && !unlocked.has(candidate.id);

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
