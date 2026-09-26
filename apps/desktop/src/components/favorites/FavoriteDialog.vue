<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useFavoritesStore } from "@/stores/favoritesStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { favoritePath } from "@/lib/favorites/target";
import { favoriteErrorMessage } from "@/lib/favorites/errors";
import { listTableFavorites } from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const { t } = useI18n();
const store = useFavoritesStore();
const connections = useConnectionStore();
const { toast } = useToast();
const name = ref("");
const code = ref("");
const codeEdited = ref(false);
const error = ref("");
const busy = ref(false);
const confirmRemove = ref(false);
const target = computed(() => (store.dialog?.mode === "edit" ? store.dialog.item : store.dialog?.target));
const path = computed(() => (target.value ? favoritePath(target.value, connections.getConfig(target.value.connectionId)?.name) : ""));
const oldPath = computed(() => (store.dialog?.mode === "relink" ? favoritePath(store.dialog.item, connections.getConfig(store.dialog.item.connectionId)?.name) : ""));
watch(
  () => store.dialog,
  (value) => {
    name.value = value?.mode === "create" ? value.target.objectName : value?.item.name || "";
    code.value = value?.mode === "create" ? "" : value?.item.code || "";
    codeEdited.value = false;
    if (value?.mode === "create") {
      void listTableFavorites()
        .then((result) => {
          if (store.dialog === value && !codeEdited.value) code.value = result.nextCode || "";
        })
        .catch(() => {
          // Preview is optional; saving without a custom code still allocates atomically.
        });
    }
    error.value = "";
    confirmRemove.value = value?.mode === "edit" && !!value.remove;
  },
  { immediate: true },
);

function close(open: boolean) {
  if (!open && !busy.value) store.dialog = null;
}
function beginRelink() {
  if (!store.dialog || store.dialog.mode !== "edit") return;
  store.relinking = { ...store.dialog.item };
  toast(t("favorites.selectTarget", { name: store.dialog.item.name }), 7000);
  store.dialog = null;
}

async function save() {
  const state = store.dialog;
  if (!state || busy.value) return;
  error.value = "";
  if (state.mode !== "relink") {
    if (![...name.value.trim()].length || [...name.value.trim()].length > 100) {
      error.value = t("favorites.invalidName");
      return;
    }
    if ((state.mode === "edit" || code.value.trim()) && !/^[A-Za-z0-9_-]{1,32}$/.test(code.value.trim())) {
      error.value = t("favorites.invalidCode");
      return;
    }
  }
  busy.value = true;
  try {
    if (state.mode === "create") {
      const result = await store.create({ target: state.target, name: name.value, code: codeEdited.value ? code.value.trim() || undefined : undefined });
      if (store.dialog !== state) return;
      if (!result.created) {
        store.dialog = { mode: "edit", item: result.item };
        await nextTick();
        error.value = t("favorites.duplicate");
        return;
      }
    } else if (state.mode === "edit") {
      await store.update(state.item.id, { name: name.value, code: code.value, expectedRevision: state.item.revision });
    } else {
      await store.relink(state.item.id, { target: state.target, expectedRevision: state.item.revision });
      store.relinking = null;
    }
    if (store.dialog === state) {
      store.dialog = null;
      toast(t("favorites.saved"), 2500);
    }
  } catch (reason) {
    if (store.dialog === state) error.value = favoriteErrorMessage(reason, t);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const state = store.dialog;
  if (!state || state.mode !== "edit" || busy.value) return;
  if (!confirmRemove.value) {
    confirmRemove.value = true;
    return;
  }
  busy.value = true;
  try {
    await store.remove(state.item);
    if (store.dialog === state) {
      store.dialog = null;
      toast(t("favorites.removed"), 2500);
    }
  } catch (reason) {
    if (store.dialog === state) error.value = favoriteErrorMessage(reason, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="!!store.dialog" @update:open="close">
    <DialogContent class="max-w-lg" :show-close-button="!busy" @escape-key-down="busy && $event.preventDefault()" @interact-outside="busy && $event.preventDefault()">
      <DialogHeader>
        <DialogTitle>{{ t(store.dialog?.mode === "create" ? "favorites.add" : store.dialog?.mode === "relink" ? "favorites.confirmRelink" : "favorites.edit") }}</DialogTitle>
        <DialogDescription v-if="store.dialog?.mode === 'relink'">{{ t("favorites.relinkHelp") }}</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <template v-if="store.dialog?.mode !== 'relink'">
          <label class="grid gap-1.5"
            >{{ t("favorites.code") }}<Input v-model="code" :disabled="busy" :placeholder="t('favorites.autoCode')" autocomplete="off" @update:model-value="codeEdited = true" /><span v-if="store.dialog?.mode === 'create' && !codeEdited" class="text-xs text-muted-foreground">{{
              t("favorites.codePreview")
            }}</span></label
          >
          <label class="grid gap-1.5">{{ t("favorites.name") }}<Input v-model="name" :disabled="busy" autocomplete="off" /></label>
        </template>
        <div v-if="oldPath" class="min-w-0 text-muted-foreground">
          <p>{{ t("favorites.target") }}</p>
          <p class="break-all">{{ oldPath }}</p>
        </div>
        <div class="min-w-0 text-muted-foreground">
          <p>{{ t(oldPath ? "favorites.newTarget" : "favorites.target") }}</p>
          <p class="break-all">{{ path }}</p>
        </div>
        <p v-if="error" role="alert" class="break-words text-destructive">{{ error }}</p>
        <p v-if="confirmRemove" class="text-destructive">{{ t("favorites.confirmRemove") }} {{ t("favorites.removeHelp") }}</p>
        <div v-if="store.dialog?.mode === 'edit'" class="flex gap-2">
          <Button type="button" variant="outline" :disabled="busy" @click="beginRelink">{{ t("favorites.relink") }}</Button>
          <Button type="button" variant="outline" class="text-destructive" :disabled="busy" @click="remove">{{ t("favorites.remove") }}</Button>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="close(false)">{{ t("favorites.cancel") }}</Button>
          <Button type="submit" :disabled="busy">{{ busy ? t("favorites.loading") : t("favorites.save") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
