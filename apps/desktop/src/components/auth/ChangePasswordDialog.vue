<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Loader2 } from "@lucide/vue";
import { useAuthStore } from "@/stores/authStore";
import { useToast } from "@/composables/useToast";
import { webChangePassword, WebAuthError } from "@/lib/auth/webAuth";
import { translateBackendError } from "@/i18n/backend-errors";

const props = withDefaults(
  defineProps<{
    /** `forced` blocks every dismissal path until the password is changed. */
    mode?: "forced" | "voluntary";
  }>(),
  { mode: "voluntary" },
);

const emit = defineEmits<{
  changed: [];
  close: [];
}>();

const forced = computed(() => props.mode === "forced");
const { t } = useI18n();
const authStore = useAuthStore();
const { toast } = useToast();

const MIN_NEW_PASSWORD_LENGTH = 6;
const oldPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const error = ref("");
const loading = ref(false);

const newPasswordLongEnough = computed(() => newPassword.value.length >= MIN_NEW_PASSWORD_LENGTH);
const passwordsMatch = computed(() => newPassword.value === confirmPassword.value);
const canSubmit = computed(() => !loading.value && oldPassword.value.length > 0 && newPasswordLongEnough.value && confirmPassword.value.length > 0 && passwordsMatch.value);

// Forced mode is a hard gate (expired or post-reset password): there is no
// cancel button, and every dismissal interaction is swallowed here.
function requestClose() {
  if (forced.value || loading.value) return;
  emit("close");
}

function handleOpenChange(open: boolean) {
  if (!open) requestClose();
}

function submitValidationError(): string | null {
  if (newPassword.value.length > 0 && !newPasswordLongEnough.value) return t("auth.passwordTooShort");
  if (confirmPassword.value.length > 0 && !passwordsMatch.value) return t("auth.passwordMismatch");
  return null;
}

async function submit() {
  if (loading.value) return;
  if (!canSubmit.value) {
    error.value = submitValidationError() ?? t("auth.changePasswordDescription");
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await webChangePassword(oldPassword.value, newPassword.value);
    authStore.mustChangePassword = false;
    authStore.passwordExpiresInDays = 90;
    toast(t("auth.passwordChanged"));
    emit("changed");
  } catch (e) {
    if (e instanceof WebAuthError) {
      const translated = e.code ? translateBackendError(t, e.code) : null;
      error.value = translated && translated !== e.code ? translated : t("auth.changePasswordFailed");
    } else {
      error.value = e instanceof Error && e.message ? e.message : t("auth.changePasswordFailed");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-md" :show-close-button="false" data-change-password-dialog @escape-key-down.prevent @pointer-down-outside.prevent @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ forced ? t("auth.forcedChangeTitle") : t("auth.changePassword") }}</DialogTitle>
        <DialogDescription>{{ forced ? t("auth.forcedChangeDescription") : t("auth.changePasswordDescription") }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="submit" autocomplete="off">
        <PasswordInput v-model="oldPassword" data-old-password :placeholder="t('auth.oldPassword')" inputClass="h-11" autocomplete="off" autofocus />
        <PasswordInput v-model="newPassword" data-new-password :placeholder="t('auth.newPassword')" inputClass="h-11" autocomplete="off" />
        <PasswordInput v-model="confirmPassword" data-confirm-password :placeholder="t('auth.confirmPassword')" inputClass="h-11" autocomplete="off" />
        <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <Button v-if="!forced" type="button" variant="outline" data-change-password-cancel :disabled="loading" @click="requestClose">
            {{ t("common.cancel") }}
          </Button>
          <Button type="submit" data-change-password-submit :disabled="!canSubmit">
            <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
            {{ loading ? t("auth.processing") : t("auth.changePassword") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
