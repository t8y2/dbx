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
        </div>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ t("common.cancel") }}</Button>
          </DialogClose>
          <Button type="submit" :disabled="saving">
            {{ saving ? t("common.processing") : t("common.save") }}
          </Button>
          <Button v-if="hasPassword" type="button" variant="destructive" @click="handleRemovePassword" :disabled="saving">
            {{ t("connectionGroup.removePassword") }}
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
import { showSetGroupPasswordDialog, setGroupPasswordValue, setGroupPasswordRemove, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
import { useConnectionStore } from "@/stores/connectionStore";
import { hashConnectionGroupPassword } from "@/lib/sidebar/connectionGroupPassword";

const { t } = useI18n();
const connectionStore = useConnectionStore();

const isOpen = ref(false);
const password = ref("");
const saving = ref(false);

const hasPassword = computed(() => {
  const node = sidebarFormTarget.value;
  if (node?.type !== "connection-group") return false;
  const group = connectionStore.sidebarLayout.groups.find((g) => g.id === node.id);
  return !!group?.passwordHash;
});

watch(
  () => showSetGroupPasswordDialog.value,
  (show) => {
    if (show) {
      password.value = setGroupPasswordValue.value;
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
    setGroupPasswordRemove.value = false;
  }
}

async function handleSubmit() {
  const node = sidebarFormTarget.value;
  if (node?.type !== "connection-group") return;

  saving.value = true;
  try {
    const hash = password.value ? await hashConnectionGroupPassword(password.value) : null;
    await connectionStore.setConnectionGroupPassword(node.id, hash);
    showSetGroupPasswordDialog.value = false;
    setGroupPasswordValue.value = "";
    setGroupPasswordRemove.value = false;
  } finally {
    saving.value = false;
  }
}

async function handleRemovePassword() {
  const node = sidebarFormTarget.value;
  if (node?.type !== "connection-group") return;

  saving.value = true;
  try {
    await connectionStore.setConnectionGroupPassword(node.id, null);
    showSetGroupPasswordDialog.value = false;
    setGroupPasswordValue.value = "";
    setGroupPasswordRemove.value = false;
  } finally {
    saving.value = false;
  }
}
</script>
