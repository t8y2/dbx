<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Input } from "@/components/ui/input";
import { Lock, Loader2, ShieldCheck, User } from "@lucide/vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import { webLogin, webSetup, WebAuthError } from "@/lib/auth/webAuth";
import type { StartupAuthentication } from "@/lib/startup/startupAuthentication";
import { translateBackendError } from "@/i18n/backend-errors";

const props = withDefaults(
  defineProps<{
    setupMode?: boolean;
  }>(),
  { setupMode: false },
);

const emit = defineEmits<{ authenticated: [payload: StartupAuthentication] }>();
const { t } = useI18n();

const USERNAME_PATTERN = /^[a-z0-9_.-]{3,64}$/;
const username = ref("");
const password = ref("");
const confirmPassword = ref("");
const error = ref("");
const loading = ref(false);

const usernameValid = computed(() => USERNAME_PATTERN.test(username.value));
const passwordsMatch = computed(() => !props.setupMode || password.value === confirmPassword.value);
const canSubmit = computed(() => !loading.value && usernameValid.value && password.value.length > 0 && passwordsMatch.value);

// The contract only accepts lowercase usernames, so normalizing as the user
// types avoids a surprise rejection at submit time (e.g. capitalized input).
watch(username, (value) => {
  const lowercased = value.toLowerCase();
  if (value !== lowercased) username.value = lowercased;
});

function authErrorMessage(failure: unknown): string {
  if (failure instanceof WebAuthError) {
    if (failure.code) {
      const translated = translateBackendError(t, failure.code);
      // An unmapped code would render as its raw snake_case string; fall back
      // to the generic message instead.
      if (translated !== failure.code) return translated;
    }
    return t("auth.loginFailed");
  }
  return failure instanceof Error && failure.message ? failure.message : t("auth.connectFailed");
}

async function submit() {
  if (loading.value) return;
  if (!usernameValid.value) {
    error.value = t("auth.usernameInvalid");
    return;
  }
  if (!passwordsMatch.value) {
    error.value = t("auth.passwordMismatch");
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const result = props.setupMode ? await webSetup(username.value, password.value) : await webLogin(username.value, password.value);
    emit("authenticated", result);
  } catch (e) {
    error.value = authErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex items-center justify-center h-screen bg-gradient-to-br from-background via-background to-blue-950/20">
    <div class="w-[360px] space-y-8">
      <div class="flex flex-col items-center gap-4">
        <AppLogo class="w-20 h-20 rounded-2xl shadow-lg shadow-blue-500/20" />
        <div class="text-center">
          <h1 class="text-2xl font-bold tracking-tight">DBX</h1>
          <p class="text-sm text-muted-foreground mt-1">
            {{ setupMode ? t("auth.setupDescription") : t("auth.loginDescription") }}
          </p>
        </div>
      </div>

      <form class="space-y-4" @submit.prevent="submit" autocomplete="off">
        <div v-if="setupMode" class="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck class="w-4 h-4" />
          <span>{{ t("auth.setupTitle") }}</span>
        </div>
        <div class="relative">
          <User class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input v-model="username" data-username-input class="h-11 pl-10" type="text" inputmode="text" :placeholder="t('auth.username')" name="username" autofocus />
        </div>
        <p v-if="username && !usernameValid" class="text-xs text-muted-foreground" data-username-invalid>{{ t("auth.usernameInvalid") }}</p>
        <div class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="password" :placeholder="setupMode ? t('auth.newPassword') : t('auth.enterPassword')" inputClass="pl-10 h-11" autocomplete="off" />
        </div>
        <div v-if="setupMode" class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="confirmPassword" :placeholder="t('auth.confirmPassword')" inputClass="pl-10 h-11" autocomplete="off" />
        </div>
        <p v-if="error" class="text-sm text-destructive text-center" role="alert">{{ error }}</p>
        <Button type="submit" class="w-full h-11 text-sm font-medium" :disabled="!canSubmit">
          <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
          {{ loading ? t("auth.processing") : setupMode ? t("auth.setPassword") : t("auth.login") }}
        </Button>
      </form>

      <p class="text-center text-xs text-muted-foreground/50">Powered by DBX</p>
    </div>
  </div>
</template>
