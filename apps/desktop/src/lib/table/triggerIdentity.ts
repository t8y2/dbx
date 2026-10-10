import type { TriggerInfo } from "@/types/database";

export function triggerIdentity(trigger: Pick<TriggerInfo, "name" | "owner">): string {
  return JSON.stringify([trigger.owner ?? null, trigger.name]);
}

export function triggerDisplayName(trigger: Pick<TriggerInfo, "name" | "owner">): string {
  return trigger.owner ? `${trigger.owner}.${trigger.name}` : trigger.name;
}
