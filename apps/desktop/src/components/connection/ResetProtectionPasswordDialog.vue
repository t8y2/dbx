<template>
  <Dialog :open="isOpen" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-md" @escape-key-down.prevent @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <ShieldAlert class="h-4 w-4 text-primary" />
          {{ t("auth.resetProtectionPasswordTitle") }}
        </DialogTitle>
        <DialogDescription>{{ t("auth.resetProtectionPasswordMessage", { name: targetName }) }}</DialogDescription>
      </DialogHeader>
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div class="space-y-2">
          <PasswordInput v-model="loginPassword" :placeholder="t('auth.resetProtectionPasswordPlaceholder')" input-class="pl-10 h-11" autocomplete="current-password" autofocus />
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("auth.resetProtectionPasswordHint") }}</p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ t("common.cancel") }}</Button>
          </DialogClose>
          <Button type="submit" variant="destructive" :disabled="submitting || !loginPassword">
            {{ submitting ? t("common.processing") : t("auth.resetProtectionPasswordConfirm") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "@lucide/vue";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { useResetProtectionPasswordPromptStore } from "@/stores/resetProtectionPasswordPromptStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useConnectionStore } from "@/stores/connectionStore";

const { t } = useI18n();
const promptStore = useResetProtectionPasswordPromptStore();
const savedSqlStore = useSavedSqlStore();
const connectionStore = useConnectionStore();

const isOpen = ref(false);
const loginPassword = ref("");
const error = ref("");
const submitting = ref(false);

const targetName = computed(() => promptStore.current?.name ?? "");

watch(
  () => promptStore.current,
  (current) => {
    if (current) {
      loginPassword.value = "";
      error.value = "";
      isOpen.value = true;
    } else {
      isOpen.value = false;
    }
  },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    promptStore.close();
  }
}

async function handleSubmit() {
  const target = promptStore.current;
  if (!target || !loginPassword.value || submitting.value) return;
  submitting.value = true;
  error.value = "";
  try {
    // The backend verifies the login password before clearing the stored
    // verifier; the store call also refreshes the in-memory lock state.
    if (target.targetType === "folder") {
      await savedSqlStore.clearSavedSqlFolderPassword(target.id, loginPassword.value);
    } else {
      await connectionStore.clearConnectionGroupPassword(target.id, loginPassword.value);
    }
    promptStore.close();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      error.value = t("auth.oldPasswordWrong");
    } else if (status === 409) {
      error.value = t("auth.clearProtectionPasswordNoLoginPassword");
    } else {
      error.value = t("auth.clearProtectionPasswordFailed");
    }
  } finally {
    submitting.value = false;
  }
}
</script>
