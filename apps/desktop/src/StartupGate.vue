<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import LoginPage from "@/components/auth/LoginPage.vue";
import SecurityMigrationWizard from "@/components/migration/SecurityMigrationWizard.vue";
import { useMigrationStore } from "@/stores/migrationStore";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { apiUrl, webPath } from "@/lib/common/webPath";

// App setup installs listeners and instantiates business stores, so even its import
// is deferred until authentication and the security migration have completed.
const App = defineAsyncComponent(() => import("./App.vue"));
const { t } = useI18n();
const migration = useMigrationStore();
const { blocking } = migration;
const checkingAuth = ref(true);
const loginRequired = ref(false);
const setupRequired = ref(false);
const authFailed = ref(false);
const enteringApp = ref(false);
let launchTransitionTimer: number | undefined;

watch(
  () => migration.state.entered,
  (entered) => {
    if (entered) {
      enteringApp.value = true;
    }
  },
);

function appReady() {
  window.clearTimeout(launchTransitionTimer);
  launchTransitionTimer = window.setTimeout(() => {
    enteringApp.value = false;
  }, 650);
}
async function initialize() {
  checkingAuth.value = true;
  authFailed.value = false;
  try {
    if (!isTauriRuntime()) {
      const response = await fetch(apiUrl("/api/auth/check"), { credentials: "same-origin" });
      if (!response.ok) throw new Error("AUTH_CHECK_FAILED");
      const result = await response.json();
      if (typeof result.required !== "boolean" || typeof result.authenticated !== "boolean") throw new Error("AUTH_CHECK_FAILED");
      setupRequired.value = result.setup_required === true;
      loginRequired.value = setupRequired.value || (result.required && !result.authenticated);
      if (loginRequired.value) {
        history.replaceState(null, "", webPath("/login"));
        return;
      }
    }
    await migration.initialize();
  } catch {
    authFailed.value = true;
  } finally {
    checkingAuth.value = false;
  }
}
async function authenticated() {
  history.replaceState(null, "", webPath("/"));
  await initialize();
}
onMounted(initialize);
</script>
<template>
  <div v-if="checkingAuth || authFailed" class="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background text-foreground" role="status">
    <p>{{ t(authFailed ? "migration.authFailed" : "migration.checking") }}</p>
    <button v-if="authFailed" class="rounded border px-4 py-2" @click="initialize">{{ t("migration.retry") }}</button>
  </div>
  <LoginPage v-else-if="loginRequired" :setup-mode="setupRequired" @authenticated="authenticated" />
  <SecurityMigrationWizard v-else-if="blocking" :store="migration" />
  <div v-else class="relative min-h-screen">
    <Suspense @resolve="appReady">
      <App />
    </Suspense>
    <Transition name="startup-fade">
      <div v-if="enteringApp" class="fixed inset-0 z-[1100] flex items-center justify-center bg-background text-foreground" role="status" aria-live="polite">
        <div class="flex flex-col items-center gap-5 text-center">
          <span class="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-2xl text-primary" aria-hidden="true">✓</span>
          <div>
            <p class="text-lg font-semibold">{{ t("migration.successTitle") }}</p>
            <p class="mt-2 text-sm text-muted-foreground">{{ t("migration.launching") }}</p>
          </div>
          <span class="h-1.5 w-24 overflow-hidden rounded-full bg-primary/15" aria-hidden="true"><span class="startup-progress block h-full w-1/2 rounded-full bg-primary" /></span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.startup-fade-enter-active,
.startup-fade-leave-active {
  transition: opacity 280ms ease;
}

.startup-fade-enter-from,
.startup-fade-leave-to {
  opacity: 0;
}

.startup-progress {
  animation: startup-progress 1.2s ease-in-out infinite;
}

@keyframes startup-progress {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(200%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .startup-progress {
    animation: none;
    transform: translateX(50%);
  }
}
</style>
