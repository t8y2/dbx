<template>
  <Dialog :open="isOpen" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-md" @escape-key-down.prevent @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-primary" />
          {{ hasPassword ? t("connectionGroup.changePassword") : t("connectionGroup.setPassword") }}
        </DialogTitle>
        <DialogDescription>{{ t("connectionGroup.setPasswordDescription") }}</DialogDescription>
      </DialogHeader>
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div class="space-y-2">
          <PasswordInput v-model="password" :placeholder="t('connectionGroup.newPasswordPlaceholder')" input-class="pl-10 h-11" autocomplete="new-password" autofocus />
          <p class="text-sm text-muted-foreground">{{ t("connectionGroup.passwordOptionalPlaceholder") }}</p>
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        </div>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ t("common.cancel") }}</Button>
          </DialogClose>
          <Button type="submit" :disabled="saving">
            {{ saving ? t("common.processing") : t("common.save") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyRound } from "@lucide/vue";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { showSetGroupPasswordDialog, setGroupPasswordValue, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
import { useConnectionStore } from "@/stores/connectionStore";

const { t } = useI18n();
const connectionStore = useConnectionStore();

const isOpen = ref(false);
const password = ref("");
const saving = ref(false);
const error = ref("");

const hasPassword = computed(() => {
  const node = sidebarFormTarget.value;
  if (node?.type !== "connection-group") return false;
  const group = connectionStore.sidebarLayout.groups.find((g) => g.id === node.id);
  return !!group?.hasPassword;
});

watch(
  () => showSetGroupPasswordDialog.value,
  (show) => {
    if (show) {
      password.value = setGroupPasswordValue.value;
      error.value = "";
      isOpen.value = true;
    } else {
      isOpen.value = false;
    }
  },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    showSetGroupPasswordDialog.value = false;
    setGroupPasswordValue.value = "";
  }
}

async function handleSubmit() {
  const node = sidebarFormTarget.value;
  if (node?.type !== "connection-group") return;
  if (!password.value) return;

  saving.value = true;
  error.value = "";
  try {
    // The backend command mints the verifier; the plaintext is only sent for
    // hashing and never persisted. Removing a password goes through the
    // login-password-gated recovery path instead of this dialog.
    await connectionStore.setConnectionGroupPassword(node.id, password.value);
    showSetGroupPasswordDialog.value = false;
    setGroupPasswordValue.value = "";
  } catch (err) {
    // Surface transport/auth failures (e.g. an expired session returning 401)
    // instead of closing silently.
    error.value = (err as { status?: number }).status === 401 ? t("auth.protectionLoginExpired") : t("auth.protectionSaveFailed");
  } finally {
    saving.value = false;
  }
}
</script>
