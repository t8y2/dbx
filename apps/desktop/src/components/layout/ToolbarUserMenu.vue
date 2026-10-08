<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Building2, ChevronDown, KeyRound, LogOut, ShieldAlert } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ChangePasswordDialog from "@/components/auth/ChangePasswordDialog.vue";
import { useAuthStore } from "@/stores/authStore";
import { webLogout } from "@/lib/auth/webAuth";
import { webPath } from "@/lib/common/webPath";

const { t } = useI18n();
const auth = useAuthStore();

const displayName = computed(() => auth.user?.display_name?.trim() || auth.user?.username || "");
const avatarText = computed(() => (displayName.value ? displayName.value.charAt(0).toUpperCase() : "?"));
const department = computed(() => auth.user?.department_name?.trim() || null);
const roles = computed(() => auth.user?.roles ?? []);
const passwordDays = computed(() => auth.passwordExpiresInDays);
const passwordExpiring = computed(() => typeof passwordDays.value === "number" && passwordDays.value > 0 && passwordDays.value <= 7);
const passwordExpired = computed(() => typeof passwordDays.value === "number" && passwordDays.value <= 0);

const showChangePassword = ref(false);
const confirmingLogout = ref(false);
const loggingOut = ref(false);

// Even a failed logout clears the local session: the server cookie is the
// authority and a full page navigation replaces all in-memory state anyway.
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await webLogout();
  } catch {
    // The navigation below is the recovery path — surface nothing.
  } finally {
    auth.reset();
    window.location.replace(webPath("/login"));
  }
}
</script>

<template>
  <DropdownMenu v-if="auth.authenticated">
    <DropdownMenuTrigger as-child>
      <button type="button" data-user-menu-trigger class="toolbar-action-button flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground" :aria-label="t('auth.userMenu')">
        <span class="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold uppercase text-primary" aria-hidden="true">{{ avatarText }}</span>
        <span class="max-w-[120px] truncate">{{ auth.user?.username }}</span>
        <ChevronDown class="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-60">
      <DropdownMenuLabel class="flex min-w-0 flex-col gap-0.5 py-2">
        <span class="truncate text-sm font-medium">{{ displayName || auth.user?.username }}</span>
        <span v-if="displayName && auth.user?.username && displayName !== auth.user.username" class="truncate text-xs font-normal text-muted-foreground">{{ auth.user.username }}</span>
      </DropdownMenuLabel>
      <div v-if="department" class="flex items-center gap-2 px-2 pb-1.5 text-xs text-muted-foreground" data-user-menu-department>
        <Building2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ department }}</span>
      </div>
      <div v-if="roles.length" class="flex flex-wrap gap-1 px-2 pb-1.5" data-user-menu-roles>
        <span v-for="role in roles" :key="role" class="inline-flex max-w-full items-center rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <span class="truncate">{{ role }}</span>
        </span>
      </div>
      <DropdownMenuSeparator />
      <div v-if="passwordExpiring || passwordExpired" class="flex items-center gap-2 px-2 py-2 text-xs" :class="passwordExpired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'" data-user-menu-password-expiry>
        <ShieldAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ passwordExpired ? t("auth.passwordExpired") : t("auth.passwordExpiresInDays", { days: passwordDays }) }}</span>
      </div>
      <DropdownMenuItem data-user-menu-change-password class="gap-2" @click="showChangePassword = true">
        <KeyRound class="h-3.5 w-3.5" aria-hidden="true" />
        {{ t("auth.changePassword") }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-user-menu-logout class="gap-2 text-destructive focus:text-destructive" @click="confirmingLogout = true">
        <LogOut class="h-3.5 w-3.5" aria-hidden="true" />
        {{ t("auth.logout") }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <ChangePasswordDialog v-if="showChangePassword" mode="voluntary" @close="showChangePassword = false" @changed="showChangePassword = false" />
  <Dialog v-model:open="confirmingLogout">
    <DialogContent class="sm:max-w-sm" :show-close-button="false">
      <DialogHeader>
        <DialogTitle>{{ t("auth.logoutConfirmTitle") }}</DialogTitle>
        <DialogDescription>{{ t("auth.logoutConfirmDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" data-user-menu-logout-cancel :disabled="loggingOut" @click="confirmingLogout = false">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" data-user-menu-logout-confirm :disabled="loggingOut" @click="logout">{{ t("auth.logoutConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
