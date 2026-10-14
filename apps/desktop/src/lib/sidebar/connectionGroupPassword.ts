import { useConnectionStore } from "@/stores/connectionStore";
import { useConnectionGroupPasswordPromptStore } from "@/stores/connectionGroupPasswordPromptStore";
import type { ConnectionGroup } from "@/types/database";
import { isProtectionPasswordFeatureActive, verifyProtectionPassword } from "./protectionPassword";
import { findConnectionLocation } from "./sidebarLayout";

export async function promptConnectionGroupUnlock(group: ConnectionGroup): Promise<boolean> {
  // Desktop never gates group access — protection passwords are web-only.
  if (!isProtectionPasswordFeatureActive() || !group.passwordHash) return true;
  const connectionStore = useConnectionStore();
  if (connectionStore.isConnectionGroupUnlocked(group.id)) return true;
  const promptStore = useConnectionGroupPasswordPromptStore();
  const unlocked = await promptStore.requestPassword({
    groupId: group.id,
    groupName: group.name,
    verify: (password) => verifyProtectionPassword(password, group.passwordHash!, (upgradedHash) => connectionStore.persistConnectionGroupPasswordHash(group.id, upgradedHash)),
  });
  if (!unlocked) return false;
  connectionStore.unlockConnectionGroup(group.id);
  return true;
}

/**
 * The sidebar group owning this connection, or undefined when the connection
 * sits at the sidebar root.
 */
export function connectionGroupForConnection(connectionId: string): ConnectionGroup | undefined {
  const layout = useConnectionStore().sidebarLayout;
  const groupId = findConnectionLocation(layout, connectionId)?.groupId;
  if (!groupId) return undefined;
  return layout.groups.find((group) => group.id === groupId);
}

/**
 * The group that gates access to this connection right now, or null when the
 * connection is reachable. Session semantics: an unlock in this session opens
 * the group again.
 */
export function lockedConnectionGroupForConnection(connectionId: string): ConnectionGroup | null {
  if (!isProtectionPasswordFeatureActive()) return null;
  const group = connectionGroupForConnection(connectionId);
  if (!group?.passwordHash) return null;
  return useConnectionStore().isConnectionGroupUnlocked(group.id) ? null : group;
}

/**
 * Drops connections sitting inside a locked (not yet unlocked) group. Shared
 * by the quick-start list so locked connections never surface there.
 */
export function filterConnectionsOutsideLockedGroups<T extends { id: string }>(connections: readonly T[]): T[] {
  return connections.filter((connection) => !lockedConnectionGroupForConnection(connection.id));
}

/**
 * Password gate for opening a connection straight from a quick-start list.
 * Prompts for the group password when the connection sits in a locked group
 * and returns whether the caller may proceed.
 */
export async function ensureConnectionGroupAccessible(connectionId: string): Promise<boolean> {
  const lockedGroup = lockedConnectionGroupForConnection(connectionId);
  if (!lockedGroup) return true;
  return promptConnectionGroupUnlock(lockedGroup);
}
