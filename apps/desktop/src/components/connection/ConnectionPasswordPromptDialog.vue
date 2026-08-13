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
    resolving.value = false;
  },
);

function submit() {
  if (resolving.value || !password.value) return;
  resolving.value = true;
  promptStore.submit(password.value);
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
