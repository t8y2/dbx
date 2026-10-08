<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import StartupLoading from "@/components/layout/StartupLoading.vue";
import { useMigrationStore } from "@/stores/migrationStore";
import { useAuthStore } from "@/stores/authStore";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { webPath } from "@/lib/common/webPath";
import { loadSavedLocale } from "@/i18n";
import { checkStartupAuthentication, type StartupAuthentication } from "@/lib/startup/startupAuthentication";
import { markStartupPhase } from "@/lib/startup/startupTiming";
import { retryStartupAfterPreloadFailure } from "@/lib/startup/startupPreloadRecovery";

// App setup installs listeners and instantiates business stores, so even its import
// is deferred until authentication and the security migration have completed.
const startupAsyncOptions = {
  loadingComponent: StartupLoading,
  errorComponent: StartupLoading,
  delay: 0,
  suspensible: false,
  onError(error: Error, _retry: () => void, fail: () => void) {
    retryStartupAfterPreloadFailure(error);
    fail();
  },
};
const App = defineAsyncComponent({ ...startupAsyncOptions, loader: () => import("./App.vue") });
const LoginPage = defineAsyncComponent({ ...startupAsyncOptions, loader: () => import("@/components/auth/LoginPage.vue") });
const SecurityMigrationWizard = defineAsyncComponent({ ...startupAsyncOptions, loader: () => import("@/components/migration/SecurityMigrationWizard.vue") });
const ChangePasswordDialog = defineAsyncComponent({ ...startupAsyncOptions, loader: () => import("@/components/auth/ChangePasswordDialog.vue") });
const props = defineProps<{ localeReady?: Promise<void> }>();
const { t } = useI18n();
const migration = useMigrationStore();
const auth = useAuthStore();
const { blocking } = migration;
const checkingAuth = ref(true);
const loginRequired = ref(false);
const setupRequired = ref(false);
const authFailed = ref(false);
const passwordChangeRequired = ref(false);
const startupAuthentication = shallowRef<StartupAuthentication>();
const checkingLocale = ref(Boolean(props.localeReady));
const localeFailed = ref(false);
let initialLocaleReady = props.localeReady;
let authRequest: AbortController | undefined;

watch(migration.blocking, (blocked) => {
  if (!blocked) markStartupPhase("migration-ready");
});

async function initializeLocale() {
  if (!initialLocaleReady && !localeFailed.value) return;
  checkingLocale.value = true;
  localeFailed.value = false;
  try {
    await (initialLocaleReady ?? loadSavedLocale());
    markStartupPhase("locale-ready");
    window.dispatchEvent(new Event("dbx:startup-ready"));
  } catch {
    localeFailed.value = true;
  } finally {
    initialLocaleReady = undefined;
    checkingLocale.value = false;
  }
}
async function initialize() {
  authRequest?.abort();
  const request = new AbortController();
  authRequest = request;
  checkingAuth.value = true;
  authFailed.value = false;
  try {
    if (!isTauriRuntime()) {
      const result = await checkStartupAuthentication(request.signal);
      if (request.signal.aborted) return;
      startupAuthentication.value = result;
      auth.applyCheckResponse(result);
      setupRequired.value = result.setup_required === true;
      loginRequired.value = setupRequired.value || (result.required && !result.authenticated);
      passwordChangeRequired.value = result.must_change_password === true && !loginRequired.value;
      if (loginRequired.value) {
        history.replaceState(null, "", webPath("/login"));
        return;
      }
      // An expired or reset password blocks the app behind a forced change
      // dialog until the password is replaced (mirrors the migration wizard's
      // blocking render).
      if (passwordChangeRequired.value) return;
    }
    markStartupPhase("auth-ready");
    await migration.initialize();
  } catch {
    if (!request.signal.aborted) authFailed.value = true;
  } finally {
    if (!request.signal.aborted) checkingAuth.value = false;
  }
}
async function authenticated(payload?: StartupAuthentication) {
  history.replaceState(null, "", webPath("/"));
  // The login/setup response already carries the full contract; applying it
  // immediately keeps downstream UI (user menu, permissions) from waiting on
  // the follow-up check below, which then refreshes the same state.
  if (payload) auth.applyCheckResponse(payload);
  await initialize();
}
async function passwordChanged() {
  passwordChangeRequired.value = false;
  await initialize();
}
// Any non-auth API answering 401 means the session cookie expired: drop back
// to the login boundary and re-run the startup check.
function handleAuthExpired() {
  auth.reset();
  startupAuthentication.value = undefined;
  passwordChangeRequired.value = false;
  setupRequired.value = false;
  loginRequired.value = false;
  void initialize();
}
// A 403 with `password_change_required` on any non-auth API flips the gate
// into the forced-change view while the session itself stays valid.
function handleAuthForceChange() {
  auth.mustChangePassword = true;
  passwordChangeRequired.value = true;
}
onMounted(() => {
  window.addEventListener("dbx:auth-expired", handleAuthExpired);
  window.addEventListener("dbx:auth-force-change", handleAuthForceChange);
  void initializeLocale();
  void initialize();
});
onUnmounted(() => {
  window.removeEventListener("dbx:auth-expired", handleAuthExpired);
  window.removeEventListener("dbx:auth-force-change", handleAuthForceChange);
  authRequest?.abort();
});
</script>
<template>
  <StartupLoading v-if="checkingLocale || localeFailed || checkingAuth || authFailed" :label="authFailed ? t('migration.authFailed') : !checkingLocale && !localeFailed ? t('migration.checking') : undefined" :error="localeFailed || authFailed" :retry="localeFailed ? initializeLocale : initialize" />
  <LoginPage v-else-if="loginRequired" :setup-mode="setupRequired" @authenticated="authenticated" />
  <ChangePasswordDialog v-else-if="passwordChangeRequired" mode="forced" @changed="passwordChanged" />
  <SecurityMigrationWizard v-else-if="blocking" :store="migration" />
  <App v-else :startup-authentication="startupAuthentication" />
</template>
