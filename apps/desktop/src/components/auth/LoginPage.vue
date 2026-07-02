<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Lock, Loader2, ShieldCheck } from "@lucide/vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import { apiUrl } from "@/lib/webPath";

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
const error = ref("");
const loading = ref(false);

async function submit() {
  if (props.setupMode && password.value !== confirmPassword.value) {
    error.value = t("auth.passwordMismatch");
    return;
  }

  loading.value = true;
  error.value = "";
  try {
    const url = apiUrl(props.setupMode ? "/api/auth/setup" : "/api/auth/login");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (res.ok) {
      emit("authenticated");
    } else {
      const text = await res.text();
      error.value = text || t("auth.loginFailed");
    }
  } catch (e: any) {
    error.value = e?.message || t("auth.connectFailed");
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
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="password" :placeholder="setupMode ? t('auth.newPassword') : t('auth.enterPassword')" inputClass="pl-10 h-11" autocomplete="off" autofocus />
        </div>
        <div v-if="setupMode" class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <PasswordInput v-model="confirmPassword" :placeholder="t('auth.confirmPassword')" inputClass="pl-10 h-11" autocomplete="off" />
        </div>
        <p v-if="error" class="text-sm text-destructive text-center">{{ error }}</p>
        <Button type="submit" class="w-full h-11 text-sm font-medium" :disabled="loading || !password || (setupMode && !confirmPassword)">
          <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
          {{ loading ? t("auth.processing") : setupMode ? t("auth.setPassword") : t("auth.login") }}
        </Button>
      </form>

      <p class="text-center text-xs text-muted-foreground/50">Powered by DBX</p>
    </div>
  </div>
</template>
