import { verifySavedSqlFolderPassword } from "@/lib/backend/api";
import { isProtectionPasswordFeatureActive } from "@/lib/sidebar/protectionPassword";
import { nearestLockedFolder } from "@/lib/sidebar/savedSqlFolderSearch";
import { useSavedSqlFolderPasswordPromptStore } from "@/stores/savedSqlFolderPasswordPromptStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";

/**
 * Whether one folder is locked right now: it carries a protection password and
 * was not unlocked in this session. Desktop has no protection passwords, so
 * folders are never locked there.
 */
export function isSavedSqlFolderLocked(folder: SavedSqlFolder): boolean {
  if (!isProtectionPasswordFeatureActive()) return false;
  return !!folder.hasPassword && !useSavedSqlStore().isSavedSqlFolderUnlocked(folder.id);
}

/**
 * The nearest folder above the file that still gates access to it, or null
 * when the file can be reached right now.
 */
export function lockedFolderForSavedSqlFile(file: Pick<SavedSqlFile, "folderId">): SavedSqlFolder | null {
  return nearestLockedFolder(file.folderId, useSavedSqlStore().allFolders, isSavedSqlFolderLocked);
}

/**
 * Drops files sitting inside a locked (not yet unlocked) branch. Shared by the
 * recent-SQL history lists so locked contents never surface there.
 */
export function excludeLockedSavedSqlFiles<T extends Pick<SavedSqlFile, "folderId">>(files: readonly T[]): T[] {
  return files.filter((file) => !lockedFolderForSavedSqlFile(file));
}

/**
 * Password gate for opening a saved SQL file straight from a history list.
 * Prompts for the folder password when the file sits in a locked branch and
 * returns whether the caller may proceed to open it.
 */
export async function ensureSavedSqlFileAccessible(file: Pick<SavedSqlFile, "folderId">): Promise<boolean> {
  const lockedFolder = lockedFolderForSavedSqlFile(file);
  if (!lockedFolder) return true;
  const store = useSavedSqlStore();
  const unlocked = await useSavedSqlFolderPasswordPromptStore().requestPassword({
    folderId: lockedFolder.id,
    folderName: lockedFolder.name,
    // The verifier stays server-side: the prompt resolves through the verify
    // command, which also migrates legacy hashes to Argon2 transparently.
    verify: (password) => verifySavedSqlFolderPassword(lockedFolder.id, password),
  });
  if (unlocked) store.unlockSavedSqlFolder(lockedFolder.id);
  return unlocked;
}
