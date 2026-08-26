<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Lock, Loader2, ShieldCheck, UserRound } from "@lucide/vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import { apiUrl } from "@/lib/common/webPath";
import { translateBackendError } from "@/i18n/backend-errors";

type AuthMode = "password" | "ldap";

interface AuthState {
  authenticated: boolean;
  required: boolean;
  setup_required: boolean;
  password_disabled?: boolean;
  ldap_enabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    setupMode?: boolean;
  }>(),
  { setupMode: false },
);

const emit = defineEmits<{ authenticated: [] }>();
const { t } = useI18n();

const password = ref("");
const confirmPassword = ref("");
const username = ref("");
const error = ref("");
const loading = ref(false);
const authMode = ref<AuthMode>("password");
const authState = ref<AuthState | null>(null);

async function refreshLdapState() {
  authState.value = null;
  try {
    const checkRes = await fetch(apiUrl("/api/auth/check"));
    if (checkRes.ok) {
      authState.value = (await checkRes.json()) as AuthState;
    }
  } catch {
    /* unreachable — fall back to password mode */
  }
  if (authState.value?.ldap_enabled) {
    authMode.value = "ldap";
  }
}

onMounted(() => {
  if (!props.setupMode) void refreshLdapState();
});

const passwordLoginEnabled = computed(() => authState.value?.password_disabled !== true);

const usernamePlaceholder = t("auth.ldapUsernamePlaceholder");

const submitDisabled = computed(() => {
  if (loading.value) return true;
  if (props.setupMode) return !password.value || !confirmPassword.value;
  if (authMode.value === "ldap") return !username.value || !password.value;
  return !password.value;
});

const submitLabel = computed(() => {
  if (loading.value) return t("auth.processing");
  if (props.setupMode) return t("auth.setPassword");
  if (authMode.value === "ldap") return t("auth.ldapLogin");
  return t("auth.login");
});

async function readAuthError(res: Response): Promise<string> {
  const text = (await res.text()).trim();
  if (!text) return t("auth.loginFailed");
  let message = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string") message = parsed.error;
  } catch {
    // not JSON — fall through with the raw body
  }
  return translateBackendError(t, message) || t("auth.loginFailed");
}

async function submit() {
  if (props.setupMode && password.value !== confirmPassword.value) {
    error.value = t("auth.passwordMismatch");
    return;
  }

  loading.value = true;
  error.value = "";
  try {
    let url: string;
    let body: Record<string, unknown>;
    if (props.setupMode) {
      url = apiUrl("/api/auth/setup");
      body = { password: password.value };
    } else if (authMode.value === "ldap") {
      url = apiUrl("/api/auth/ldap-login");
      body = {
        username: username.value,
        password: password.value,
      };
    } else {
      url = apiUrl("/api/auth/login");
      body = { password: password.value };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      emit("authenticated");
    } else {
      error.value = await readAuthError(res);
    }
  } catch (e: any) {
    error.value = e?.message || t("auth.connectFailed");
  } finally {
    loading.value = false;
  }
}

const ldapEnabled = computed(() => authState.value?.ldap_enabled === true);
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
        <template v-if="!setupMode && authMode === 'ldap'">
          <div class="relative">
            <UserRound class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input v-model="username" :placeholder="usernamePlaceholder" class="pl-10 h-11" autocomplete="username" autofocus />
          </div>
        </template>
        <div class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="password" :placeholder="setupMode ? t('auth.newPassword') : t('auth.enterPassword')" inputClass="pl-10 h-11" autocomplete="current-password" :autofocus="setupMode || authMode !== 'ldap'" />
        </div>
        <div v-if="setupMode" class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="confirmPassword" :placeholder="t('auth.confirmPassword')" inputClass="pl-10 h-11" autocomplete="off" />
        </div>
        <p v-if="error" class="text-sm text-destructive text-center">{{ error }}</p>
        <Button type="submit" class="w-full h-11 text-sm font-medium" :disabled="submitDisabled">
          <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
          {{ submitLabel }}
        </Button>
        <div v-if="!setupMode && ldapEnabled && passwordLoginEnabled" class="flex justify-center">
          <button type="button" class="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline" @click="authMode = authMode === 'ldap' ? 'password' : 'ldap'">
            {{ authMode === "ldap" ? t("auth.usePassword") : t("auth.ldapLogin") }}
          </button>
        </div>
      </form>

      <p class="text-center text-xs text-muted-foreground/50">Powered by DBX</p>
    </div>
  </div>
</template>
