import { ref } from "vue";
import { defineStore } from "pinia";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { hasPermission as checkPermission, PERMISSION_KEYS } from "@/lib/auth/permissions";
import type { StartupAuthentication } from "@/lib/startup/startupAuthentication";

/**
 * Web authentication/session state mirrored from `GET /api/auth/check` (and
 * login/setup responses). The desktop app has no web auth, so it starts in a
 * bypass state: authenticated, admin, every permission.
 */
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const user = ref<StartupAuthentication["user"]>(null);
  const permissions = ref<string[]>([]);
  const isAdmin = ref(false);
  const mustChangePassword = ref(false);
  const passwordExpiresInDays = ref<number | null>(null);
  const loaded = ref(false);

  function applyDesktopBypass() {
    authenticated.value = true;
    user.value = null;
    permissions.value = [...PERMISSION_KEYS];
    isAdmin.value = true;
    mustChangePassword.value = false;
    passwordExpiresInDays.value = null;
    loaded.value = true;
  }

  if (isTauriRuntime()) applyDesktopBypass();

  /** Maps a full auth-check payload (or login/setup response) into state. */
  function applyCheckResponse(payload: StartupAuthentication) {
    authenticated.value = payload.authenticated === true;
    user.value = payload.user ?? null;
    permissions.value = Array.isArray(payload.permissions) ? [...payload.permissions] : [];
    isAdmin.value = payload.user?.is_admin === true;
    mustChangePassword.value = payload.must_change_password === true;
    passwordExpiresInDays.value = typeof payload.password_expires_in_days === "number" ? payload.password_expires_in_days : null;
    loaded.value = true;
  }

  /** Clears the session (logout / 401 expiry). Desktop stays bypassed. */
  function reset() {
    authenticated.value = false;
    user.value = null;
    permissions.value = [];
    isAdmin.value = false;
    mustChangePassword.value = false;
    passwordExpiresInDays.value = null;
    loaded.value = false;
    if (isTauriRuntime()) applyDesktopBypass();
  }

  /** Administrators hold every permission by definition. */
  function hasPermission(key: string): boolean {
    return checkPermission(permissions.value, key, isAdmin.value);
  }

  return { authenticated, user, permissions, isAdmin, mustChangePassword, passwordExpiresInDays, loaded, applyCheckResponse, reset, hasPermission };
});
