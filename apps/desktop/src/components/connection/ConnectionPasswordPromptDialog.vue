<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { KeyRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { useConnectionPasswordPromptStore } from "@/stores/connectionPasswordPromptStore";

const { t } = useI18n();
const promptStore = useConnectionPasswordPromptStore();

const password = ref("");
const rememberPassword = ref(false);
const resolving = ref(false);
const open = computed({
  get: () => !!promptStore.pending,
  set: (value: boolean) => {
    if (!value && promptStore.pending) promptStore.cancel();
  },
});

// Reset the input for each new prompt (including the next one in the queue).
watch(
  () => promptStore.pending,
  () => {
    password.value = "";
    rememberPassword.value = false;
    resolving.value = false;
  },
);

function submit() {
  if (resolving.value || !password.value) return;
  resolving.value = true;
  promptStore.submit(password.value, rememberPassword.value);
}

function cancel() {
  if (resolving.value) return;
  promptStore.cancel();
}
</script>

<template>
  <Dialog v-model:open="open" @escape-key-down.prevent @interact-outside.prevent>
    <DialogContent class="sm:max-w-[420px]" :show-close-button="false">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <KeyRound class="h-5 w-5" />
          {{ t("connection.promptPasswordTitle") }}
        </DialogTitle>
        <DialogDescription class="text-muted-foreground">
          {{ t("connection.promptPasswordMessage", { connection: promptStore.pending?.connectionName ?? "" }) }}
        </DialogDescription>
      </DialogHeader>

      <div class="py-1">
        <PasswordInput v-model="password" autofocus :placeholder="t('connection.promptPasswordPlaceholder')" :disabled="resolving" @keydown.enter.prevent="submit" />
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input v-model="rememberPassword" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :disabled="resolving" />
          <span>{{ t("connection.promptRememberPassword") }}</span>
        </label>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="resolving" @click="cancel">
          {{ t("connection.promptPasswordCancel") }}
        </Button>
        <Button :disabled="resolving || !password" @click="submit">
          {{ t("connection.promptPasswordSubmit") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
