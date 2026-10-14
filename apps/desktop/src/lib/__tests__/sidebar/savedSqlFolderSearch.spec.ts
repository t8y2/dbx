import { describe, expect, it } from "vitest";
import { fileOrAncestorHasPassword, folderOrAncestorHasPassword, nearestLockedFolder } from "@/lib/sidebar/savedSqlFolderSearch";
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

describe("folderOrAncestorHasPassword", () => {
  it("treats an unprotected folder as searchable", () => {
    const folders = [folder("a"), folder("b", { parentFolderId: "a" })];
    expect(folderOrAncestorHasPassword(folders[1], folders)).toBe(false);
  });

  it("treats a folder with its own password as protected", () => {
    const folders = [folder("a", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" })];
    expect(folderOrAncestorHasPassword(folders[0], folders)).toBe(true);
  });

  it("hides children of a password-protected folder from search", () => {
    const folders = [folder("parent", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" }), folder("child", { parentFolderId: "parent" }), folder("grandchild", { parentFolderId: "child" })];
    expect(folderOrAncestorHasPassword(folders[1], folders)).toBe(true);
    expect(folderOrAncestorHasPassword(folders[2], folders)).toBe(true);
  });

  it("does not protect siblings of a protected folder", () => {
    const folders = [folder("parent"), folder("locked-sibling", { parentFolderId: "parent", passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" }), folder("open-sibling", { parentFolderId: "parent" })];
    expect(folderOrAncestorHasPassword(folders[2], folders)).toBe(false);
  });

  it("returns false when the parent chain is broken", () => {
    const folders = [folder("orphan", { parentFolderId: "missing" })];
    expect(folderOrAncestorHasPassword(folders[0], folders)).toBe(false);
  });

  it("terminates on a parent cycle instead of looping forever", () => {
    const folders = [folder("a", { parentFolderId: "b" }), folder("b", { parentFolderId: "a" })];
    expect(folderOrAncestorHasPassword(folders[0], folders)).toBe(false);
  });
});

describe("fileOrAncestorHasPassword", () => {
  function file(folderId?: string) {
    return folderId ? { folderId } : {};
  }

  it("treats files outside any folder as visible to search", () => {
    const folders = [folder("locked", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" })];
    expect(fileOrAncestorHasPassword(file(), folders)).toBe(false);
  });

  it("treats files of an unprotected folder as visible to search", () => {
    const folders = [folder("open")];
    expect(fileOrAncestorHasPassword(file("open"), folders)).toBe(false);
  });

  it("hides files of a password-protected folder from search", () => {
    const folders = [folder("locked", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" })];
    expect(fileOrAncestorHasPassword(file("locked"), folders)).toBe(true);
  });

  it("hides files nested under a password-protected folder from search", () => {
    const folders = [folder("locked", { passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" }), folder("child", { parentFolderId: "locked" })];
    expect(fileOrAncestorHasPassword(file("child"), folders)).toBe(true);
  });

  it("treats files of an unknown folder as visible to search", () => {
    const folders = [folder("open")];
    expect(fileOrAncestorHasPassword(file("missing"), folders)).toBe(false);
  });
});

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

  it("returns null on a broken or cyclic chain instead of looping forever", () => {
    const folders = [folder("orphan", { parentFolderId: "missing" }), folder("a", { parentFolderId: "b" }), folder("b", { parentFolderId: "a" })];
    expect(nearestLockedFolder("orphan", folders, isFolderLocked)).toBeNull();
    expect(nearestLockedFolder("a", folders, isFolderLocked)).toBeNull();
  });
});
