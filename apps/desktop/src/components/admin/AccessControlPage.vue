<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, Building2, ShieldCheck, UsersRound } from "@lucide/vue";
import BlacklistManagement from "@/components/admin/BlacklistManagement.vue";
import DepartmentManagement from "@/components/admin/DepartmentManagement.vue";
import RoleManagement from "@/components/admin/RoleManagement.vue";
import UserManagement from "@/components/admin/UserManagement.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const { t } = useI18n();
const activeTab = ref("users");
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <header class="shrink-0 border-b bg-card/60 px-5 py-4">
      <h1 class="text-lg font-semibold tracking-tight">{{ t("accessControl.title") }}</h1>
      <p class="mt-1 text-xs text-muted-foreground">{{ t("accessControl.description") }}</p>
    </header>
    <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col gap-0">
      <div class="shrink-0 border-b px-5 pt-3">
        <TabsList class="h-9">
          <TabsTrigger value="users" class="gap-1.5 data-[state=active]:text-green-600"><UsersRound class="h-3.5 w-3.5" />{{ t("accessControl.tabs.users") }}</TabsTrigger>
          <TabsTrigger value="departments" class="gap-1.5 data-[state=active]:text-green-600"><Building2 class="h-3.5 w-3.5" />{{ t("accessControl.tabs.departments") }}</TabsTrigger>
          <TabsTrigger value="roles" class="gap-1.5 data-[state=active]:text-green-600"><ShieldCheck class="h-3.5 w-3.5" />{{ t("accessControl.tabs.roles") }}</TabsTrigger>
          <TabsTrigger value="blacklist" class="gap-1.5 data-[state=active]:text-green-600"><Ban class="h-3.5 w-3.5" />{{ t("accessControl.tabs.blacklist") }}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="users" class="m-0 min-h-0 flex-1"><UserManagement /></TabsContent>
      <TabsContent value="departments" class="m-0 min-h-0 flex-1"><DepartmentManagement /></TabsContent>
      <TabsContent value="roles" class="m-0 min-h-0 flex-1"><RoleManagement /></TabsContent>
      <TabsContent value="blacklist" class="m-0 min-h-0 flex-1"><BlacklistManagement /></TabsContent>
    </Tabs>
  </div>
</template>
