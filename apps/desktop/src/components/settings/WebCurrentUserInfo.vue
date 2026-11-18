<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "@/components/ui/label";
import { apiUrl } from "@/lib/common/webPath";

/**
 * `设置 → 安全` head block showing the identity behind the current Web session
 * (username, role, provider) — the only place it surfaces after login.
 *
 * Kept in its own component for the same reason as WebLoginCaptchaSetting: the
 * settings dialog is a very large single-file component and adding reactive
 * state there pushes vue-tsc over its recursion limit. Self-contained fetch so
 * the value stays fresh regardless of when the dialog opens.
 */
const { t } = useI18n();

const username = ref("");
const isAdmin = ref(false);
const providerLabel = ref("");
const loaded = ref(false);

async function load() {
  try {
    const res = await fetch(apiUrl("/api/auth/check"), { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as {
      authenticated?: boolean;
      user?: { username?: string; role?: string; provider_id?: string };
      providers?: { id?: string; label?: string }[];
    };
    if (!body.authenticated || !body.user?.username) return;
    username.value = body.user.username;
    isAdmin.value = body.user.role === "admin";
    const provider = body.providers?.find((item) => item.id === body.user?.provider_id);
    providerLabel.value = provider?.label ?? body.user.provider_id ?? "";
    loaded.value = true;
  } catch {
    // Server unreachable — hide the block; the dialog must stay usable.
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div v-if="loaded" class="space-y-2 rounded-md border bg-background px-3 py-2.5" data-testid="current-user">
    <Label class="text-base">{{ t("auth.currentUser") }}</Label>
    <p class="text-sm" data-testid="current-user-summary">
      <span class="font-medium" data-testid="current-user-name">{{ username }}</span>
      <span class="text-muted-foreground"> · {{ isAdmin ? t("auth.roleAdmin") : t("auth.roleMember") }}</span>
      <span v-if="providerLabel" class="text-muted-foreground"> · {{ t("auth.loginMethod") }}: {{ providerLabel }}</span>
    </p>
  </div>
</template>
