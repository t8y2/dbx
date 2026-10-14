import { useConnectionStore } from "@/stores/connectionStore";
import { useConnectionGroupPasswordPromptStore } from "@/stores/connectionGroupPasswordPromptStore";
import type { ConnectionGroup } from "@/types/database";
import { isProtectionPasswordFeatureActive, verifyProtectionPassword } from "./protectionPassword";

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
