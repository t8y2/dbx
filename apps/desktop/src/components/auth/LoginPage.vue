<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Lock, Loader2, ShieldCheck, ShieldQuestion } from "@lucide/vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import { apiUrl } from "@/lib/common/webPath";
import { translateBackendError } from "@/i18n/backend-errors";

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
const captchaCode = ref("");
const captchaRequired = ref(false);
const captchaId = ref("");
const captchaImage = ref("");
const captchaLoading = ref(false);
const error = ref("");
const loading = ref(false);

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
    const payload = props.setupMode ? { password: password.value } : captchaRequired.value ? { password: password.value, captcha_id: captchaId.value, captcha_code: captchaCode.value } : { password: password.value };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

      <p class="text-center text-xs text-muted-foreground/50">Powered by DBX</p>
    </div>
  </div>
</template>
