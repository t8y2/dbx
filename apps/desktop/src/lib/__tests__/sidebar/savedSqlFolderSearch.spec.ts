import { describe, expect, it } from "vitest";
import { folderOrAncestorHasPassword } from "@/lib/sidebar/savedSqlFolderSearch";
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
