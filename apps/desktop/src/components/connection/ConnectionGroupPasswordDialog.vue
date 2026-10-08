<template>
  <Dialog :open="isOpen" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-md" @escape-key-down.prevent @pointer-down-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-primary" />
          {{ t("connectionGroup.passwordPromptTitle") }}
        </DialogTitle>
        <DialogDescription>{{ t("connectionGroup.passwordPromptMessage", { name: groupName }) }}</DialogDescription>
      </DialogHeader>
      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div class="space-y-2">
          <PasswordInput v-model="password" :placeholder="t('connectionGroup.passwordPromptPlaceholder')" input-class="pl-10 h-11" autocomplete="new-password" autofocus />
          <p v-if="incorrect" class="text-sm text-destructive">{{ t("connectionGroup.passwordIncorrect") }}</p>
        </div>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ t("connectionGroup.passwordPromptCancel") }}</Button>
          </DialogClose>
          <Button type="submit" :disabled="verifying || !password">
            {{ verifying ? t("connectionGroup.processing") : t("connectionGroup.passwordPromptSubmit") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyRound } from "@lucide/vue";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { useConnectionGroupPasswordPromptStore } from "@/stores/connectionGroupPasswordPromptStore";

const { t } = useI18n();
const promptStore = useConnectionGroupPasswordPromptStore();

const isOpen = ref(false);
const groupName = ref("");
const password = ref("");
const incorrect = ref(false);
const verifying = ref(false);

watch(
  () => promptStore.current,
  (current) => {
    if (current) {
      groupName.value = current.groupName;
      password.value = "";
      incorrect.value = false;
      isOpen.value = true;
    } else {
      isOpen.value = false;
    }
  },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    promptStore.resolve(false);
  }
}

async function handleSubmit() {
  if (!promptStore.current || !password.value) return;
  verifying.value = true;
  incorrect.value = false;
  try {
    const valid = await promptStore.current.verify(password.value);
    if (valid) {
      promptStore.resolve(true);
    } else {
      incorrect.value = true;
      password.value = "";
    }
  } finally {
    verifying.value = false;
  }
}
</script>
