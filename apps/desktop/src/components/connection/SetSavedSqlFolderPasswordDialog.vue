<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-md" @escape-key-down.prevent @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-primary" />
          {{ hasPassword ? t("savedSql.changePassword") : t("savedSql.setPassword") }}
        </DialogTitle>
        <DialogDescription>{{ t("savedSql.setPasswordDescription") }}</DialogDescription>
      </DialogHeader>
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div class="space-y-2">
          <PasswordInput v-model="password" :placeholder="t('savedSql.newPasswordPlaceholder')" input-class="pl-10 h-11" autocomplete="new-password" autofocus />
          <p class="text-sm text-muted-foreground">{{ t("savedSql.passwordOptionalPlaceholder") }}</p>
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
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyRound } from "@lucide/vue";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import type { SavedSqlFolder } from "@/types/database";

const props = defineProps<{
  open: boolean;
  folder: SavedSqlFolder | null;
  setPassword: (folderId: string, password: string) => Promise<void>;
}>();

const emit = defineEmits<{
  (e: "update:open", open: boolean): void;
  (e: "changed", hasPassword: boolean, removed: boolean): void;
}>();

const { t } = useI18n();

const password = ref("");
const saving = ref(false);

const hasPassword = computed(() => !!props.folder?.hasPassword);

watch(
  () => props.open,
  (open) => {
    if (open) password.value = "";
  },
);

function handleOpenChange(open: boolean) {
  emit("update:open", open);
}

async function handleSubmit() {
  const folder = props.folder;
  if (!folder || !password.value) return;
  saving.value = true;
  try {
    // The verifier is minted by the backend command; the plaintext is only
    // sent for hashing and never persisted. Removing a password goes through
    // the login-password-gated recovery path instead of this dialog.
    await props.setPassword(folder.id, password.value);
    emit("update:open", false);
    emit("changed", hasPassword.value, false);
  } finally {
    saving.value = false;
  }
}
</script>
