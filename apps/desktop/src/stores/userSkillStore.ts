import { defineStore } from "pinia";
import { computed, ref } from "vue";
import * as api from "@/lib/backend/api";
import type { UserSkillMeta, UserSkillRootListing, UserSkillRootSettings } from "@/types/userSkills";

type UserSkillRootStatus = UserSkillRootListing["status"];

/**
 * Metadata-only catalog of discoverable skills for the AI panel selector.
 * Selection state does NOT live here: it is panel-session scoped inside
 * AiAssistant (like activeTemplateIds), so closing the panel clears it while
 * the catalog cache survives. This store never holds skill bodies - bodies
 * are read once per send through the backend (prd.md:36/:56).
 */
export const useUserSkillStore = defineStore("userSkillStore", () => {
  const defaultRootSkills = ref<UserSkillMeta[]>([]);
  const customRootSkills = ref<UserSkillMeta[]>([]);
  const defaultRootStatus = ref<UserSkillRootStatus>("missing");
  const customRootStatus = ref<UserSkillRootStatus>("missing");
  const isLoading = ref(false);
  const lastError = ref<string | null>(null);
  const hasLoadedOnce = ref(false);

  /** Custom-root results sort first when enabled (prd.md:29). */
  const groupedSkills = computed<Array<{ source: "custom" | "default"; skills: UserSkillMeta[] }>>(() => {
    const groups: Array<{ source: "custom" | "default"; skills: UserSkillMeta[] }> = [];
    if (customRootSkills.value.length > 0) groups.push({ source: "custom", skills: customRootSkills.value });
    if (defaultRootSkills.value.length > 0) groups.push({ source: "default", skills: defaultRootSkills.value });
    return groups;
  });

  const totalCount = computed(() => defaultRootSkills.value.length + customRootSkills.value.length);

  async function refresh(rootSettings: UserSkillRootSettings): Promise<boolean> {
    isLoading.value = true;
    lastError.value = null;
    try {
      const result = await api.listUserSkills(rootSettings);
      defaultRootSkills.value = result.defaultRoot.skills;
      defaultRootStatus.value = result.defaultRoot.status;
      customRootSkills.value = result.customRoot?.skills ?? [];
      customRootStatus.value = result.customRoot?.status ?? "missing";
      hasLoadedOnce.value = true;
      return true;
    } catch (error) {
      // Keep failures retryable; the selector shows lastError with a Retry action.
      lastError.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** Display metadata lookup for selected ids, including stale ids whose skill has since vanished. */
  function metaFor(id: string): UserSkillMeta | undefined {
    return defaultRootSkills.value.find((skill) => skill.id === id) ?? customRootSkills.value.find((skill) => skill.id === id);
  }

  return {
    defaultRootSkills,
    customRootSkills,
    defaultRootStatus,
    customRootStatus,
    isLoading,
    lastError,
    hasLoadedOnce,
    groupedSkills,
    totalCount,
    refresh,
    metaFor,
  };
});
