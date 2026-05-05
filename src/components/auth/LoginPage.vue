<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Loader2 } from "lucide-vue-next";

const emit = defineEmits<{ authenticated: [] }>();

const password = ref("");
const error = ref("");
const loading = ref(false);

async function login() {
  loading.value = true;
  error.value = "";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (res.ok) {
      emit("authenticated");
    } else {
      const text = await res.text();
      error.value = text || "密码错误";
    }
  } catch (e: any) {
    error.value = e?.message || "连接失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex items-center justify-center h-screen bg-gradient-to-br from-background via-background to-blue-950/20">
    <div class="w-[360px] space-y-8">
      <div class="flex flex-col items-center gap-4">
        <img src="/logo.png" alt="DBX" class="w-20 h-20 rounded-2xl shadow-lg shadow-blue-500/20" />
        <div class="text-center">
          <h1 class="text-2xl font-bold tracking-tight">DBX</h1>
          <p class="text-sm text-muted-foreground mt-1">数据库管理工具</p>
        </div>
      </div>

      <form class="space-y-4" @submit.prevent="login" autocomplete="off">
        <div class="relative">
          <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            v-model="password"
            type="password"
            placeholder="请输入访问密码"
            class="pl-10 h-11"
            autocomplete="off"
            autofocus
          />
        </div>
        <p v-if="error" class="text-sm text-destructive text-center">{{ error }}</p>
        <Button type="submit" class="w-full h-11 text-sm font-medium" :disabled="loading || !password">
          <Loader2 v-if="loading" class="w-4 h-4 animate-spin mr-2" />
          {{ loading ? "登录中..." : "登录" }}
        </Button>
      </form>

      <p class="text-center text-xs text-muted-foreground/50">
        Powered by DBX
      </p>
    </div>
  </div>
</template>
