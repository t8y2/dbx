<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Lock, Loader2, ShieldCheck, ShieldQuestion, User } from "@lucide/vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import { apiUrl } from "@/lib/common/webPath";
import { translateBackendError } from "@/i18n/backend-errors";
import type { StartupAuthProvider } from "@/lib/startup/startupAuthentication";

const props = withDefaults(
  defineProps<{
    setupMode?: boolean;
    /** Auth methods returned by `auth/check`; empty for single-local-account deployments. */
    providers?: StartupAuthProvider[];
  }>(),
  { setupMode: false, providers: () => [] },
);

const emit = defineEmits<{ authenticated: [] }>();
const { t } = useI18n();

const password = ref("");
const username = ref("");
const confirmPassword = ref("");
const captchaCode = ref("");
const captchaRequired = ref(false);
const captchaId = ref("");
const captchaImage = ref("");
const captchaLoading = ref(false);
const error = ref("");
const loading = ref(false);

const redirectProviders = computed(() => props.providers.filter((provider) => provider.mode === "redirect"));
const formProviders = computed(() => props.providers.filter((provider) => provider.mode === "form"));
// Two or more form providers (e.g. the built-in local accounts plus LDAP) need an explicit
// choice; with a single one the backend resolves it and the page keeps the legacy look.
const needsProviderChoice = computed(() => formProviders.value.length > 1);
const selectedProviderId = ref("");
const selectedProvider = computed(
  () => formProviders.value.find((provider) => provider.id === selectedProviderId.value) ?? formProviders.value[0],
);
const requiresUsername = computed(() => selectedProvider.value?.requires_username === true);

// A replaced provider list (auth/check refetch) invalidates the picked id.
watch(
  () => props.providers,
  () => {
    selectedProviderId.value = "";
  },
);

/** Failed OIDC callbacks redirect to /login?error=...; translate the error code here. */
function readCallbackError() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  if (!code) return;
  error.value = translateBackendError(t, code) || t("auth.loginFailed");
  history.replaceState(null, "", window.location.pathname);
}

/**
 * Redirect provider: navigates the whole page to the server-side authorize endpoint (the server builds
 * the IdP authorization URL with state/PKCE); on success the callback endpoint plants the session cookie and returns to the site.
 */
function startSso(provider: StartupAuthProvider) {
  const next = window.location.pathname + window.location.search;
  window.location.href = apiUrl(`/api/auth/oidc/${encodeURIComponent(provider.id)}/authorize?next=${encodeURIComponent(next)}`);
}

// The auth routes report failures as `{"error": "..."}`, so unwrap that before
// translating; anything else is treated as a plain-text message.
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

/**
 * Fetch a fresh image challenge. Called once on mount and after every failed
 * attempt: the server consumes a challenge on use, so a rejected login leaves
 * the image stale.
 *
 * A 204 means the server does not want a challenge right now (`DBX_WEB_CAPTCHA`
 * is `off`, or `auto` before any failed attempt), so the field is hidden.
 */
async function refreshCaptcha() {
  if (props.setupMode) return;
  captchaLoading.value = true;
  try {
    const res = await fetch(apiUrl("/api/auth/captcha"), { headers: { Accept: "application/json" } });
    if (res.status === 204) {
      captchaRequired.value = false;
      captchaId.value = "";
      captchaImage.value = "";
      captchaCode.value = "";
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { id?: string; image?: string };
    if (body.id && body.image) {
      captchaRequired.value = true;
      captchaId.value = body.id;
      captchaImage.value = body.image;
      captchaCode.value = "";
    }
  } catch (e: any) {
    captchaRequired.value = false;
    captchaId.value = "";
    captchaImage.value = "";
    error.value = e?.message || t("auth.captchaFailed");
  } finally {
    captchaLoading.value = false;
  }
}

async function submit() {
  if (props.setupMode && password.value !== confirmPassword.value) {
    error.value = t("auth.passwordMismatch");
    return;
  }
  if (!props.setupMode && captchaRequired.value && !captchaId.value) {
    error.value = t("auth.captchaFailed");
    await refreshCaptcha();
    return;
  }

  loading.value = true;
  error.value = "";
  try {
    const url = apiUrl(props.setupMode ? "/api/auth/setup" : "/api/auth/login");
    const usernameValue = requiresUsername.value ? username.value.trim() : "";
    const basePayload: Record<string, unknown> = props.setupMode ? { password: password.value } : { password: password.value };
    if (!props.setupMode && usernameValue) basePayload.username = usernameValue;
    if (!props.setupMode && needsProviderChoice.value && selectedProvider.value) basePayload.provider = selectedProvider.value.id;
    if (!props.setupMode && captchaRequired.value) {
      basePayload.captcha_id = captchaId.value;
      basePayload.captcha_code = captchaCode.value;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    if (res.ok) {
      emit("authenticated");
    } else {
      error.value = await readAuthError(res);
      if (!props.setupMode) await refreshCaptcha();
    }
  } catch (e: any) {
    error.value = e?.message || t("auth.connectFailed");
    if (!props.setupMode) await refreshCaptcha();
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshCaptcha();
  readCallbackError();
});
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
        <div v-if="!setupMode && needsProviderChoice" class="space-y-1.5">
          <Label class="text-xs font-normal text-muted-foreground">{{ t("auth.loginMethod") }}</Label>
          <div class="grid grid-cols-2 gap-2" role="radiogroup" :aria-label="t('auth.loginMethod')">
            <Button
              v-for="provider in formProviders"
              :key="provider.id"
              type="button"
              :variant="provider.id === selectedProvider?.id ? 'default' : 'outline'"
              class="h-11 text-sm"
              role="radio"
              :aria-checked="provider.id === selectedProvider?.id"
              :data-testid="`provider-option-${provider.id}`"
              @click="selectedProviderId = provider.id"
            >
              {{ provider.label }}
            </Button>
          </div>
        </div>
        <div v-if="requiresUsername" class="relative">
          <User class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input v-model="username" :placeholder="t('auth.enterUsername')" class="pl-10 h-11" autocomplete="username" data-testid="login-username" />
        </div>
        <div class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="password" :placeholder="setupMode ? t('auth.newPassword') : t('auth.enterPassword')" inputClass="pl-10 h-11" autocomplete="off" autofocus />
        </div>
        <div v-if="setupMode" class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="confirmPassword" :placeholder="t('auth.confirmPassword')" inputClass="pl-10 h-11" autocomplete="off" />
        </div>
        <div v-if="!setupMode && captchaRequired" class="flex items-start gap-2">
          <div class="relative flex-1">
            <ShieldQuestion class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input v-model="captchaCode" :placeholder="t('auth.captchaPlaceholder')" class="pl-10 h-11 uppercase tracking-[0.35em]" maxlength="5" autocomplete="off" data-testid="captcha-input" />
          </div>
          <button
            type="button"
            class="relative h-11 w-[112px] shrink-0 overflow-hidden rounded-md border bg-muted/40 transition-opacity hover:opacity-80 disabled:opacity-60"
            :title="t('auth.captchaRefresh')"
            :aria-label="t('auth.captchaRefresh')"
            data-testid="captcha-refresh"
            :disabled="captchaLoading"
            @click="refreshCaptcha"
          >
            <img v-if="captchaImage" :src="captchaImage" :alt="t('auth.captchaPlaceholder')" class="h-full w-full object-cover" data-testid="captcha-image" />
            <Loader2 v-else class="absolute left-1/2 top-1/2 w-4 h-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
          </button>
        </div>
        <p v-if="error" class="text-sm text-destructive text-center">{{ error }}</p>
        <Button type="submit" class="w-full h-11 text-sm font-medium" :disabled="loading || !password || (setupMode && !confirmPassword) || (!setupMode && captchaRequired && !captchaCode)">
          <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
          {{ loading ? t("auth.processing") : setupMode ? t("auth.setPassword") : t("auth.login") }}
        </Button>
      </form>

      <div v-if="redirectProviders.length > 0" class="space-y-3">
        <div class="flex items-center gap-3 text-xs text-muted-foreground">
          <span class="h-px flex-1 bg-border"></span>
          {{ t("auth.ssoDivider") }}
          <span class="h-px flex-1 bg-border"></span>
        </div>
        <Button v-for="provider in redirectProviders" :key="provider.id" type="button" variant="outline" class="w-full h-11 text-sm" data-testid="sso-button" @click="startSso(provider)">
          {{ t("auth.ssoLoginWith", { provider: provider.label }) }}
        </Button>
      </div>

      <p class="text-center text-xs text-muted-foreground/50">Powered by DBX</p>
    </div>
  </div>
</template>
