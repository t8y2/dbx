import { ref } from "vue";
import { defineStore } from "pinia";
import * as api from "@/lib/backend/api";
import type { TunnelProfile } from "@/types/database";

/**
 * Shared tunnel profiles (Settings > Tunnels). Connections reference a
 * profile by id via `transport_layers[].profile_id`; the backend resolves
 * the reference at connect time, so profile edits reach every referencing
 * connection without touching the stored connections.
 */
export const useTunnelProfileStore = defineStore("tunnelProfiles", () => {
  const profiles = ref<TunnelProfile[]>([]);
  const isLoaded = ref(false);

  async function init() {
    if (isLoaded.value) return;
    await refresh();
  }

  async function refresh() {
    try {
      profiles.value = (await api.loadTunnelProfiles()) || [];
      isLoaded.value = true;
    } catch {
      // Backend unavailable (e.g. stale web session): keep previous state and
      // retry on the next init/refresh call.
    }
  }

  function profileById(id: string | undefined): TunnelProfile | undefined {
    if (!id) return undefined;
    return profiles.value.find((profile) => profile.id === id);
  }

  async function saveProfiles(next: TunnelProfile[]) {
    const previous = profiles.value;
    profiles.value = next;
    try {
      await api.saveTunnelProfiles(next);
    } catch (error) {
      profiles.value = previous;
      throw error;
    }
  }

  /**
   * Tests a profile's transport layer in isolation (no downstream database).
   * The draft profile is passed straight through, so it validates the values
   * currently in the editor rather than the last-saved copy.
   */
  async function testProfile(profile: TunnelProfile): Promise<string> {
    return api.testTunnelProfile(profile);
  }

  return { profiles, isLoaded, init, refresh, profileById, saveProfiles, testProfile };
});
