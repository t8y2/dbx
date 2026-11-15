<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2 } from "@lucide/vue";
import { apiUrl } from "@/lib/common/webPath";

/**
 * Local user management under `Settings → Security` (admin only). External-provider
 * (LDAP/SSO) users are JIT-provisioned on first login; their records can also be disabled/deleted here.
 */
const { t } = useI18n();

interface AdminUser {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: "admin" | "member";
  provider_id: string;
  disabled: boolean;
  has_password: boolean;
  created_at: number;
}

const users = ref<AdminUser[]>([]);
const loading = ref(false);
const saving = ref(false);
const message = ref("");
const messageIsError = ref(false);
const showCreate = ref(false);
const newUsername = ref("");
const newPassword = ref("");
const newRole = ref<"admin" | "member">("member");
const resettingId = ref("");
const resetPassword = ref("");

async function load() {
  loading.value = true;
  try {
    const res = await fetch(apiUrl("/api/auth/admin/users"), { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { users?: AdminUser[] };
    users.value = body.users ?? [];
  } catch {
    // keep the current state when the server is unreachable
  } finally {
    loading.value = false;
  }
}

function fail(e: unknown, fallback: string) {
  messageIsError.value = true;
  message.value = e instanceof Error ? e.message : fallback;
}

async function createUser() {
  if (!newUsername.value.trim() || !newPassword.value) return;
  saving.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl("/api/auth/admin/users"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: newUsername.value.trim(), password: newPassword.value, role: newRole.value }),
    });
    if (res.ok) {
      messageIsError.value = false;
      message.value = t("settings.authUsersCreated");
      showCreate.value = false;
      newUsername.value = "";
      newPassword.value = "";
      newRole.value = "member";
      await load();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      messageIsError.value = true;
      message.value = body.error || t("settings.authUsersSaveFailed");
    }
  } catch (e: any) {
    fail(e, t("settings.authUsersSaveFailed"));
  } finally {
    saving.value = false;
  }
}

async function patchUser(user: AdminUser, changes: Record<string, unknown>) {
  saving.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl(`/api/auth/admin/users/${encodeURIComponent(user.id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (res.ok) {
      messageIsError.value = false;
      message.value = t("settings.authUsersSaved");
      resettingId.value = "";
      resetPassword.value = "";
      await load();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      messageIsError.value = true;
      message.value = body.error || t("settings.authUsersSaveFailed");
    }
  } catch (e: any) {
    fail(e, t("settings.authUsersSaveFailed"));
  } finally {
    saving.value = false;
  }
}

async function deleteUser(user: AdminUser) {
  if (!window.confirm(t("settings.authUsersRemoveConfirm", { username: user.username }))) return;
  saving.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl(`/api/auth/admin/users/${encodeURIComponent(user.id)}`), { method: "DELETE" });
    if (res.ok) {
      messageIsError.value = false;
      message.value = t("settings.authUsersSaved");
      await load();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      messageIsError.value = true;
      message.value = body.error || t("settings.authUsersSaveFailed");
    }
  } catch (e: any) {
    fail(e, t("settings.authUsersSaveFailed"));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-4" data-settings-search-id="web-auth-users">
    <div class="flex items-center justify-between">
      <Label class="text-base">{{ t("settings.authUsersTitle") }}</Label>
      <Loader2 v-if="loading || saving" class="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
    <p class="text-sm text-muted-foreground">{{ t("settings.authUsersDescription") }}</p>

    <div v-for="user in users" :key="user.id" class="rounded-md border border-border/60 p-3 space-y-2" :data-testid="`auth-user-${user.username}`">
      <div class="flex items-center gap-2">
        <span class="font-medium text-sm">{{ user.username }}</span>
        <span class="rounded bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">{{ user.role }}</span>
        <span v-if="user.provider_id !== 'local'" class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ user.provider_id }}</span>
        <span v-if="user.disabled" class="text-xs text-destructive">{{ t("settings.authUsersDisabled") }}</span>
        <div class="ml-auto flex items-center gap-1">
          <select class="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs" :value="user.role" :data-testid="`auth-user-role-${user.username}`" @change="patchUser(user, { role: ($event.target as HTMLSelectElement).value })">
            <option value="member">{{ t("settings.authProvidersRoleMember") }}</option>
            <option value="admin">{{ t("settings.authProvidersRoleAdmin") }}</option>
          </select>
          <Button variant="outline" size="sm" class="h-7" @click="patchUser(user, { disabled: !user.disabled })">
            {{ user.disabled ? t("settings.authProvidersEnable") : t("settings.authProvidersDisable") }}
          </Button>
          <Button v-if="user.has_password" variant="outline" size="sm" class="h-7" data-testid="auth-user-reset" @click="resettingId = resettingId === user.id ? '' : user.id">
            {{ t("settings.authUsersReset") }}
          </Button>
          <Button variant="outline" size="sm" class="h-7 text-destructive hover:text-destructive" @click="deleteUser(user)">
            <Trash2 class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div v-if="resettingId === user.id" class="flex items-center gap-2">
        <Input v-model="resetPassword" type="password" class="h-7 max-w-[220px]" :placeholder="t('settings.authUsersNewPassword')" />
        <Button size="sm" class="h-7" :disabled="!resetPassword" @click="patchUser(user, { password: resetPassword })">
          {{ t("common.save") }}
        </Button>
      </div>
    </div>

    <div v-if="!showCreate" class="flex">
      <Button variant="outline" size="sm" class="gap-1.5" data-testid="auth-user-add" @click="showCreate = true"> <Plus class="h-3.5 w-3.5" /> {{ t("settings.authUsersAdd") }} </Button>
    </div>
    <div v-else class="rounded-md border border-border/60 p-4 space-y-3" data-testid="auth-user-create-form">
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <Label class="text-xs">{{ t("settings.authUsersUsername") }}</Label>
          <Input v-model="newUsername" class="h-8" data-testid="auth-user-new-username" />
        </div>
        <div class="space-y-1">
          <Label class="text-xs">{{ t("settings.authUsersPassword") }}</Label>
          <Input v-model="newPassword" type="password" class="h-8" data-testid="auth-user-new-password" />
        </div>
      </div>
      <div class="space-y-1">
        <Label class="text-xs">{{ t("settings.authProvidersDefaultRole") }}</Label>
        <select v-model="newRole" class="h-8 rounded-md border border-border/60 bg-background px-2 text-sm" data-testid="auth-user-new-role">
          <option value="member">{{ t("settings.authProvidersRoleMember") }}</option>
          <option value="admin">{{ t("settings.authProvidersRoleAdmin") }}</option>
        </select>
      </div>
      <div class="flex gap-2">
        <Button size="sm" class="h-8" :disabled="!newUsername.trim() || !newPassword || saving" data-testid="auth-user-create" @click="createUser">
          {{ t("common.save") }}
        </Button>
        <Button variant="ghost" size="sm" class="h-8" @click="showCreate = false">{{ t("common.cancel") }}</Button>
      </div>
    </div>

    <p v-if="message" class="text-xs" :class="messageIsError ? 'text-destructive' : 'text-green-500'">{{ message }}</p>
  </div>
</template>
