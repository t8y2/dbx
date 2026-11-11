<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "@lucide/vue";
import { apiUrl } from "@/lib/common/webPath";

/**
 * `设置 → 安全` entry for the Web login captcha (`DBX_WEB_CAPTCHA` in the
 * environment pins it, in which case the control is read-only).
 *
 * Kept in its own component on purpose: the settings dialog is a very large
 * single-file component and adding reactive state there pushes vue-tsc over its
 * recursion limit.
 */
const { t } = useI18n();

const mode = ref("auto");
const envLocked = ref(false);
const saving = ref(false);
const message = ref("");
const messageIsError = ref(false);

const options = computed(() => [
  { value: "always", label: t("settings.webCaptchaAlways") },
  { value: "auto", label: t("settings.webCaptchaAuto") },
  { value: "off", label: t("settings.webCaptchaOff") },
]);

async function load() {
  try {
    const res = await fetch(apiUrl("/api/app-settings/web-login-captcha"), { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { mode?: string; envLocked?: boolean };
    mode.value = body.mode === "always" || body.mode === "off" ? body.mode : "auto";
    envLocked.value = Boolean(body.envLocked);
  } catch {
    // Leave the default in place; the dialog must stay usable when the server
    // is unreachable.
  }
}

async function select(value: string) {
  if (envLocked.value || saving.value || value === mode.value) return;
  saving.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl("/api/app-settings/web-login-captcha"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: value }),
    });
    if (res.ok) {
      mode.value = value;
      messageIsError.value = false;
      message.value = t("settings.webCaptchaSaved");
    } else {
      messageIsError.value = true;
      message.value = res.status === 409 ? t("settings.webCaptchaEnvLocked") : t("settings.webCaptchaSaveFailed");
      void load();
    }
  } catch (e: any) {
    messageIsError.value = true;
    message.value = e?.message || t("settings.webCaptchaSaveFailed");
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-3" data-settings-search-id="web-login-captcha">
    <Label class="text-base">{{ t("settings.webCaptchaTitle") }}</Label>
    <p class="text-sm text-muted-foreground">
      {{ t("settings.webCaptchaDescription") }}
    </p>
    <div class="flex items-center gap-2" data-testid="web-captcha-mode">
      <Tabs :model-value="mode" class="w-fit" @update:model-value="(value) => select(String(value))">
        <TabsList class="h-9" :class="{ 'pointer-events-none opacity-60': envLocked || saving }">
          <TabsTrigger v-for="option in options" :key="option.value" :value="option.value" class="px-3">
            {{ option.label }}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Loader2 v-if="saving" class="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
    <p v-if="envLocked" class="text-xs text-muted-foreground">
      {{ t("settings.webCaptchaEnvLocked") }}
    </p>
    <p v-if="message" class="text-xs" :class="messageIsError ? 'text-destructive' : 'text-green-500'">
      {{ message }}
    </p>
  </div>
</template>
